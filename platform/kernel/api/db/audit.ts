/**
 * The write helpers (ADR-0018, architecture.md §4 step 6): every insert, update and delete of a business table goes through
 * them, and each writes its audit row in the same transaction, so a change and its audit commit or roll back together.
 * Updates and deletes name the row version they were based on; an older one is refused with 409 `stale_version`.
 */
import { eq, getTableColumns, sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { getTableConfig, type PgColumn, type PgTable } from 'drizzle-orm/pg-core';

import { ConflictError, NotFoundError } from '../errors/app-error';
import { auditLog, type AuditAction } from './audit-log.table';
import { auditPolicyOf } from './audit-policy';
import type { DbContext, Tx } from './types';

/** A business table: the base columns (columns.ts) and an `audited` declaration. */
export type BaseTable = PgTable & {
    id: PgColumn;
    rowVersion: PgColumn;
    updatedAt: PgColumn;
    updatedBy: PgColumn;
    createdBy: PgColumn;
};

const CONTEXTS = new WeakMap<object, DbContext>();

/** Called by `scoped` for the transaction it opens: the helpers take the actor and the request from here. */
export function bindContext(tx: Tx, ctx: DbContext) {
    CONTEXTS.set(tx, ctx);
}

function contextOf(tx: Tx): DbContext {
    const ctx = CONTEXTS.get(tx);
    if (!ctx) throw new Error('the write helpers take only a transaction opened by db.scoped()');
    return ctx;
}

const nameOf = (table: PgTable) => {
    const { schema, name } = getTableConfig(table);
    return schema ? `${schema}.${name}` : name;
};

function assertAudited(table: PgTable) {
    if (auditPolicyOf(table) !== 'audited')
        throw new Error(`${nameOf(table)} is not declared audited(): its writes cannot be audited`);
}

/** A row as JSON: dates as ISO strings, bigint (santim) as strings, so no amount turns into a float. */
function plain(row: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(row).map(([k, v]) => [
            k,
            typeof v === 'bigint' ? v.toString() : v instanceof Date ? v.toISOString() : v
        ])
    );
}

/** What changes on every write: not part of what the person changed. */
const BOOKKEEPING = new Set(['updatedAt', 'updatedBy', 'rowVersion']);

async function writeAudit(
    tx: Tx,
    entry: { action: AuditAction; table?: PgTable; rowId?: string; eventType?: string; diff?: unknown }
) {
    const ctx = contextOf(tx);
    await tx.insert(auditLog).values({
        action: entry.action,
        tableName: entry.table ? nameOf(entry.table) : null,
        rowId: entry.rowId ?? null,
        eventType: entry.eventType ?? null,
        diff: entry.diff ?? null,
        actorId: ctx.userId ?? null,
        unitId: ctx.unitId ?? null,
        regionId: ctx.regionId ?? null,
        orgPath: ctx.scopePath ?? null,
        requestId: ctx.requestId ?? null,
        ip: ctx.ip ?? null
    });
}

export async function insertAudited<T extends BaseTable>(
    tx: Tx,
    table: T,
    values: InferInsertModel<T>
): Promise<InferSelectModel<T>> {
    assertAudited(table);
    const ctx = contextOf(tx);
    const rows = (await tx
        .insert(table)
        .values({ ...values, createdBy: ctx.userId ?? null, updatedBy: ctx.userId ?? null } as never)
        .returning()) as InferSelectModel<T>[];
    const created = rows[0] as InferSelectModel<T> & { id: string };
    await writeAudit(tx, { action: 'insert', table, rowId: created.id, diff: { after: plain(created) } });
    return created;
}

/** The row, locked for this transaction, if `expectedVersion` is still current. */
async function lockCurrent<T extends BaseTable>(tx: Tx, table: T, id: string, expectedVersion: number) {
    // a plain PgTable for select(): Drizzle's typing of a generic table here is a conditional type tsc cannot resolve
    const source: PgTable = table;
    const rows = (await tx.select().from(source).where(eq(table.id, id)).for('update')) as Record<string, unknown>[];
    const current = rows[0];
    if (!current) throw new NotFoundError();
    if (current.rowVersion !== expectedVersion)
        throw new ConflictError('stale_version', {
            detail: `Version ${expectedVersion} was changed; the current version is ${String(current.rowVersion)}.`
        });
    return current;
}

export async function updateAudited<T extends BaseTable>(
    tx: Tx,
    table: T,
    id: string,
    expectedVersion: number,
    changes: Partial<InferInsertModel<T>>
): Promise<InferSelectModel<T>> {
    assertAudited(table);
    const ctx = contextOf(tx);
    const before = await lockCurrent(tx, table, id, expectedVersion);
    const rows = (await tx
        .update(table)
        .set({
            ...changes,
            rowVersion: sql`${table.rowVersion} + 1`,
            updatedAt: new Date(),
            updatedBy: ctx.userId ?? null
        })
        .where(eq(table.id, id))
        .returning()) as Record<string, unknown>[];
    const after = rows[0] ?? {};
    const was = plain(before);
    const is = plain(after);
    const changed = Object.keys(getTableColumns(table)).filter(
        (k) => !BOOKKEEPING.has(k) && JSON.stringify(was[k]) !== JSON.stringify(is[k])
    );
    await writeAudit(tx, {
        action: 'update',
        table,
        rowId: id,
        diff: {
            before: Object.fromEntries(changed.map((k) => [k, was[k]])),
            after: Object.fromEntries(changed.map((k) => [k, is[k]]))
        }
    });
    return after as InferSelectModel<T>;
}

export async function deleteAudited<T extends BaseTable>(
    tx: Tx,
    table: T,
    id: string,
    expectedVersion: number
): Promise<void> {
    assertAudited(table);
    const before = await lockCurrent(tx, table, id, expectedVersion);
    await tx.delete(table).where(eq(table.id, id));
    await writeAudit(tx, { action: 'delete', table, rowId: id, diff: { before: plain(before) } });
}

/** A non-row event (a reveal, an export, a denial) in the audit log, in the caller's transaction. */
export async function recordEvent(
    tx: Tx,
    event: { type: string; table?: PgTable; rowId?: string; data?: Record<string, unknown> }
): Promise<void> {
    await writeAudit(tx, {
        action: 'event',
        eventType: event.type,
        table: event.table,
        rowId: event.rowId,
        diff: event.data ? plain(event.data) : undefined
    });
}

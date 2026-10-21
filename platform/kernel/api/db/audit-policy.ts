/**
 * Which tables are audited (ADR-0018: a change without an audit row is a bug). A table file declares its table with
 * `audited(table)`, or `notAudited(table, reason)` for the few that must not be (the audit log itself). A test in the API
 * checks every table of every slice is one or the other, and the write helpers refuse a table that is not `audited`.
 */
import type { PgTable } from 'drizzle-orm/pg-core';

const AUDITED = new WeakSet<PgTable>();
const NOT_AUDITED = new WeakMap<PgTable, string>();

export function audited<T extends PgTable>(table: T): T {
    AUDITED.add(table);
    return table;
}

export function notAudited<T extends PgTable>(table: T, reason: string): T {
    NOT_AUDITED.set(table, reason);
    return table;
}

/** 'audited', the reason a table is not, or undefined when the table file has declared neither. */
export function auditPolicyOf(table: PgTable): 'audited' | { notAudited: string } | undefined {
    if (AUDITED.has(table)) return 'audited';
    const reason = NOT_AUDITED.get(table);
    return reason === undefined ? undefined : { notAudited: reason };
}

/**
 * The database foundation on a real PostgreSQL 16 (task 0.7): the role bootstrap and the migration history from zero, then
 * the audited write helpers as itrms_app on a sample table. Every change writes exactly one audit row in its own
 * transaction; a rollback leaves neither; the audit log refuses UPDATE, DELETE and TRUNCATE; a stale row_version is 409.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { Body, Controller, Inject, Param, Patch, Module, type DynamicModule } from '@nestjs/common';
import { createHttpApp, createLogger, DATABASE, KernelModule } from '@itrms/kernel/api';
import { loadConfig } from '@itrms/kernel/config';
import {
    audited,
    auditLog,
    baseColumns,
    createDatabase,
    deleteAudited,
    insertAudited,
    notAudited,
    recordEvent,
    ROLES_SQL,
    updateAudited,
    type Database
} from '@itrms/kernel/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { pgSchema, text } from 'drizzle-orm/pg-core';
import { createZodDto } from 'nestjs-zod';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

// the dev stack's image (infra/compose/docker-compose.yml)
const IMAGE = 'postgres:16.15-alpine3.23@sha256:621a761097839bdb50207afd6b87a72f38e2d718dd46c3d744828d8917c4f1e0';
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');

const sample = pgSchema('sample');
const things = audited(sample.table('things', { ...baseColumns(), name: text('name').notNull() }));
const scratch = notAudited(sample.table('scratch', { ...baseColumns(), note: text('note') }), 'test table');

const password = () => randomBytes(12).toString('hex');
const PASSWORDS = { owner: password(), app: password(), system: password(), backup: password() };

let container: StartedPostgreSqlContainer;
let urlFor: (role: string, pw: string) => string;
let db: Database;
let owner: Client;

/** The audit rows of one row, oldest first, read as the owner (outside any request). */
async function auditOf(rowId: string) {
    const ownerDb = drizzle(owner);
    return ownerDb.select().from(auditLog).where(eq(auditLog.rowId, rowId)).orderBy(auditLog.at);
}

beforeAll(async () => {
    container = await new PostgreSqlContainer(IMAGE).withDatabase('itrms').withPassword(password()).start();
    urlFor = (role, pw) =>
        `postgres://${role}:${pw}@${container.getHost()}:${container.getMappedPort(5432)}/${container.getDatabase()}`;

    // the role bootstrap, as a superuser, the passwords on stdin (as psql variables), never on a command line
    const bootstrap =
        Object.entries(PASSWORDS)
            .map(([role, pw]) => `\\set ${role}_password '${pw}'\n`)
            .join('') + readFileSync(ROLES_SQL, 'utf8');
    await container.copyContentToContainer([{ content: bootstrap, target: '/tmp/roles.psql' }]);
    const result = await container.exec([
        'psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        container.getUsername(),
        '-d',
        'itrms',
        '-f',
        '/tmp/roles.psql'
    ]);
    if (result.exitCode !== 0) throw new Error(`roles.psql failed: ${result.output}`);

    // the migration history from zero, as the owner
    const migrator = new Pool({ connectionString: urlFor('itrms_owner', PASSWORDS.owner) });
    await migrate(drizzle(migrator), {
        migrationsFolder: MIGRATIONS,
        migrationsSchema: 'drizzle',
        migrationsTable: '__drizzle_migrations'
    });
    await migrator.end();

    // a sample business table, as a slice's migration would create it
    owner = new Client({ connectionString: urlFor('itrms_owner', PASSWORDS.owner) });
    await owner.connect();
    await owner.query(`
        CREATE SCHEMA sample;
        CREATE TABLE sample.things (
            id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
            updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, row_version integer NOT NULL DEFAULT 1,
            name text NOT NULL);
        CREATE TABLE sample.scratch (LIKE sample.things INCLUDING ALL);
        GRANT USAGE ON SCHEMA sample TO itrms_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON sample.things, sample.scratch TO itrms_app;`);

    db = createDatabase(urlFor('itrms_app', PASSWORDS.app));
}, 240_000);

afterAll(async () => {
    await db?.close();
    await owner?.end();
    await container?.stop();
});

const ctx = { requestId: 'req-1', userId: '0199f0a0-0000-7000-8000-000000000001', ip: '10.0.0.9' };

describe('the role bootstrap and the migrations', () => {
    it('create the four roles with their limits, and run again without harm', async () => {
        const { rows } = await owner.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
            "SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname LIKE 'itrms\\_%' ORDER BY rolname"
        );
        expect(rows).toEqual([
            { rolname: 'itrms_app', rolbypassrls: false, rolsuper: false },
            { rolname: 'itrms_backup', rolbypassrls: false, rolsuper: false },
            { rolname: 'itrms_owner', rolbypassrls: false, rolsuper: false },
            { rolname: 'itrms_system', rolbypassrls: true, rolsuper: false }
        ]);
        const again = await container.exec([
            'psql',
            '-v',
            'ON_ERROR_STOP=1',
            '-U',
            container.getUsername(),
            '-d',
            'itrms',
            '-f',
            '/tmp/roles.psql'
        ]);
        expect(again.exitCode).toBe(0);
    });
});

describe('the audited write helpers', () => {
    it('write exactly one audit row per insert, update and delete, in the same transaction', async () => {
        const inTx = async (rowId: string, action: string) => {
            // the audit row is visible inside the transaction and was written by it (its xmin is this transaction)
            return db.scoped(ctx, async (tx) => {
                const { rows } = await tx.execute<{ same_tx: boolean }>(sql`
                    select (xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text) as same_tx
                    from kernel.audit_log where row_id = ${rowId} and action = ${action}`);
                return rows;
            });
        };
        const created = await db.scoped(ctx, async (tx) => {
            const row = await insertAudited(tx, things, { name: 'first' });
            const { rows } = await tx.execute<{ same_tx: boolean }>(sql`
                select (xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text) as same_tx
                from kernel.audit_log where row_id = ${row.id}`);
            expect(rows).toEqual([{ same_tx: true }]);
            return row;
        });
        expect(created).toMatchObject({ name: 'first', rowVersion: 1, createdBy: ctx.userId });
        expect(await inTx(created.id, 'insert')).toEqual([{ same_tx: false }]); // committed by the earlier transaction

        const updated = await db.scoped(ctx, (tx) => updateAudited(tx, things, created.id, 1, { name: 'second' }));
        expect(updated).toMatchObject({ name: 'second', rowVersion: 2, updatedBy: ctx.userId });
        await db.scoped(ctx, (tx) => deleteAudited(tx, things, created.id, 2));

        const rows = await auditOf(created.id);
        expect(rows.map((r) => r.action)).toEqual(['insert', 'update', 'delete']);
        expect(rows[0]).toMatchObject({
            tableName: 'sample.things',
            actorId: ctx.userId,
            requestId: 'req-1',
            ip: '10.0.0.9',
            diff: { after: expect.objectContaining({ name: 'first', rowVersion: 1 }) as unknown }
        });
        expect(rows[1]?.diff).toEqual({ before: { name: 'first' }, after: { name: 'second' } });
        expect(rows[2]?.diff).toMatchObject({ before: { name: 'second', rowVersion: 2 } });
    });

    it('leave neither the row nor its audit after a rollback', async () => {
        let id = '';
        await expect(
            db.scoped(ctx, async (tx) => {
                id = (await insertAudited(tx, things, { name: 'rolled back' })).id;
                await recordEvent(tx, { type: 'thing.viewed', table: things, rowId: id });
                throw new Error('the request failed');
            })
        ).rejects.toThrow('the request failed');
        expect(id).not.toBe('');
        const { rows } = await owner.query('SELECT 1 FROM sample.things WHERE id = $1', [id]);
        expect(rows).toEqual([]);
        expect(await auditOf(id)).toEqual([]);
    });

    it('refuse a stale row_version (409 stale_version) and leave the row as it was', async () => {
        const row = await db.scoped(ctx, (tx) => insertAudited(tx, things, { name: 'v1' }));
        await db.scoped(ctx, (tx) => updateAudited(tx, things, row.id, 1, { name: 'v2' }));
        await expect(
            db.scoped(ctx, (tx) => updateAudited(tx, things, row.id, 1, { name: 'lost update' }))
        ).rejects.toMatchObject({ status: 409, code: 'stale_version' });
        await expect(db.scoped(ctx, (tx) => deleteAudited(tx, things, row.id, 1))).rejects.toMatchObject({
            status: 409
        });
        const { rows } = await owner.query<{ name: string; row_version: number }>(
            'SELECT name, row_version FROM sample.things WHERE id = $1',
            [row.id]
        );
        expect(rows).toEqual([{ name: 'v2', row_version: 2 }]);
        expect((await auditOf(row.id)).map((r) => r.action)).toEqual(['insert', 'update']);
    });

    it('refuse a table that is not declared audited, and a transaction not opened by scoped', async () => {
        await expect(db.scoped(ctx, (tx) => insertAudited(tx, scratch, { note: 'x' }))).rejects.toThrow(
            /sample.scratch is not declared audited/
        );
        const pool = new Pool({ connectionString: urlFor('itrms_app', PASSWORDS.app) });
        try {
            await expect(drizzle(pool).transaction((tx) => insertAudited(tx, things, { name: 'x' }))).rejects.toThrow(
                /only a transaction opened by db.scoped/
            );
        } finally {
            await pool.end();
        }
    });
});

describe('the audit log', () => {
    it('refuses UPDATE, DELETE and TRUNCATE: the API role has no such privilege, and the trigger stops even the owner', async () => {
        const row = await db.scoped(ctx, (tx) => insertAudited(tx, things, { name: 'audited' }));
        const app = new Client({ connectionString: urlFor('itrms_app', PASSWORDS.app) });
        await app.connect();
        try {
            await expect(
                app.query("UPDATE kernel.audit_log SET action = 'event' WHERE row_id = $1", [row.id])
            ).rejects.toMatchObject({ code: '42501' });
            await expect(app.query('DELETE FROM kernel.audit_log WHERE row_id = $1', [row.id])).rejects.toMatchObject({
                code: '42501'
            });
        } finally {
            await app.end();
        }
        await expect(owner.query("UPDATE kernel.audit_log SET ip = 'x' WHERE row_id = $1", [row.id])).rejects.toThrow(
            /append-only: UPDATE/
        );
        await expect(owner.query('DELETE FROM kernel.audit_log WHERE row_id = $1', [row.id])).rejects.toThrow(
            /append-only: DELETE/
        );
        await expect(owner.query('TRUNCATE kernel.audit_log')).rejects.toThrow(/append-only: TRUNCATE/);
        expect(await auditOf(row.id)).toHaveLength(1);
    });
});

describe('over HTTP', () => {
    class Rename extends createZodDto(z.object({ name: z.string().min(1), rowVersion: z.number().int() })) {}

    @Controller('things')
    class ThingsController {
        constructor(@Inject(DATABASE) private readonly database: Database) {}

        @Patch(':id')
        rename(@Param('id') id: string, @Body() body: Rename) {
            return this.database.scoped({ requestId: 'http' }, (tx) =>
                updateAudited(tx, things, id, body.rowVersion, { name: body.name })
            );
        }
    }

    @Module({ controllers: [ThingsController] })
    class ThingsModule {}

    it('answers a stale row_version with 409 problem+json stale_version', async () => {
        const config = loadConfig('http', { DATABASE_URL: urlFor('itrms_app', PASSWORDS.app) });
        const logger = createLogger(config, new Writable({ write: (_c, _e, cb) => cb() }));
        // a database of its own: the app closes it at shutdown
        const database = createDatabase(config.DATABASE_URL);
        const root: DynamicModule = {
            module: ThingsModule,
            imports: [KernelModule.forRoot(config, logger, { database })]
        };
        const app = await createHttpApp(root, config, logger);
        await app.init();
        await app.getHttpAdapter().getInstance().ready();
        try {
            const row = await db.scoped(ctx, (tx) => insertAudited(tx, things, { name: 'one' }));
            const inject = (rowVersion: number) =>
                app
                    .getHttpAdapter()
                    .getInstance()
                    .inject({
                        method: 'PATCH',
                        url: `/things/${row.id}`,
                        payload: { name: `v${rowVersion + 1}`, rowVersion },
                        headers: { 'accept-language': 'en' }
                    });
            expect((await inject(1)).statusCode).toBe(200);
            const stale = await inject(1);
            expect(stale.statusCode).toBe(409);
            expect(stale.headers['content-type']).toBe('application/problem+json; charset=utf-8');
            expect(stale.json()).toMatchObject({ code: 'stale_version', status: 409 });
            expect((await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/readyz' })).json()).toEqual(
                {
                    status: 'ok',
                    checks: { database: 'ok' }
                }
            );
        } finally {
            await app.close();
        }
    });
});

/**
 * The database of a process (ADR-0003, ADR-0011): a pg pool as one role (the API: `itrms_app`) and `scoped(ctx, fn)`, the
 * only way request code reaches it. `scoped` opens a transaction and sets the request's context as transaction-local
 * settings (`set_config(…, true)`), which the RLS policies (task 0.9) and the audit helpers read; nothing outlives the
 * transaction, so a pooled connection never carries one request's context into the next.
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { bindContext } from './audit';
import type { DbContext, Tx } from './types';

export type { Db, DbContext, Tx } from './types';

export interface Database {
    /** Runs `fn` in one transaction with `ctx` set for RLS and the audit log; commits when it returns, rolls back when it throws. */
    scoped<T>(ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
    /** `select 1`, for the readiness check. */
    ping(): Promise<void>;
    close(): Promise<void>;
}

const SETTINGS: [keyof DbContext, string][] = [
    ['requestId', 'app.request_id'],
    ['userId', 'app.user_id'],
    ['regionId', 'app.region_id'],
    ['unitId', 'app.unit_id'],
    ['scopePath', 'app.scope_path'],
    ['ip', 'app.ip']
];

export function createDatabase(url: string, options: { max?: number; applicationName?: string } = {}): Database {
    const pool = new Pool({
        connectionString: url,
        max: options.max ?? 10,
        application_name: options.applicationName ?? 'itrms-api',
        // a statement that runs away is cut, so one request cannot hold a connection for ever
        statement_timeout: 30_000
    });
    const db = drizzle(pool);
    return {
        scoped(ctx, fn) {
            return db.transaction(async (tx) => {
                // one round trip; '' for anything unknown (the policies read settings null-safely: nullif(…, ''))
                await tx.execute(
                    sql`select ${sql.join(
                        SETTINGS.map(([key, name]) => sql`set_config(${name}, ${ctx[key] ?? ''}, true)`),
                        sql`, `
                    )}`
                );
                bindContext(tx, ctx);
                return fn(tx);
            });
        },
        async ping() {
            await pool.query('select 1');
        },
        async close() {
            await pool.end();
        }
    };
}

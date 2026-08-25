/**
 * The queries behind the health check.
 *
 * No AuthScope: these read no tenant data. They exist so that the one endpoint
 * left holding raw SQL in `server.ts` stops being an exception to the rule
 * every other query follows.
 */
import { pool } from '../db/pool.js';

/** Answers only if the database answers. A connection from the pool is not enough. */
export async function ping(): Promise<boolean> {
  const { rows } = await pool.query<{ ok: number }>('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}

export async function migrationsApplied(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM schema_migrations',
  );
  return Number(rows[0]?.count ?? 0);
}

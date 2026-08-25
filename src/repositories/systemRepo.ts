import { pool } from '../db/pool.js';

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

import pg from 'pg';
import { config } from '../config.js';
import { translatePgError } from '../errors.js';

// int8 comes back as a string to avoid precision loss. These are minor units,
// well inside MAX_SAFE_INTEGER.
pg.types.setTypeParser(20, (v: string) => Number(v));

/** Managed databases need TLS; local compose Postgres has no certificate. */
function sslFor(url: string): pg.PoolConfig['ssl'] {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'db') {
    return undefined;
  }
  return { rejectUnauthorized: true };
}

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: sslFor(config.databaseUrl),
  // 200 concurrent holds on one slot leaves 199 transactions waiting inside the
  // exclusion constraint, each holding a client. At 10 the proof failed on
  // plumbing rather than on the invariant.
  max: Number(process.env.PG_POOL_MAX ?? 20),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});

export type Tx = pg.PoolClient;

export interface ActorContext {
  actorId: string | null;
  reason: string;
}

/** Deadlock and serialization failure. The transaction is gone; a replay is safe. */
const RETRYABLE = new Set(['40P01', '40001']);

/**
 * The actor and reason go in with set_config(..., true) — SET LOCAL, so they
 * cannot survive on a pooled connection and attribute the next request's audit
 * rows to this actor. The audit trigger reads them.
 *
 * The retry is for real deadlocks: two overlapping inserts each place a GiST
 * index entry, then each waits on the other, and Postgres shoots one. The
 * victim rolls back entirely, so replaying is safe — and a deadlock here is a
 * lost race, which the brief requires to be a clean 409 rather than a 500.
 */
export async function withTransaction<T>(
  actor: ActorContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT set_config($1, $2, true), set_config($3, $4, true)',
        ['atrium.actor_id', actor.actorId ?? '', 'atrium.reason', actor.reason],
      );
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const code = (err as { code?: string }).code;
      if (attempt < 2 && typeof code === 'string' && RETRYABLE.has(code)) continue;
      throw translatePgError(err) ?? err;
    } finally {
      client.release();
    }
  }
}

export async function query<R extends pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  try {
    const res = await pool.query<R>(text, params);
    return res.rows;
  } catch (err) {
    throw translatePgError(err) ?? err;
  }
}

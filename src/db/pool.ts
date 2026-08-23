import pg from 'pg';
import { config } from '../config.js';
import { translatePgError } from '../errors.js';

// Money is bigint in the database. node-postgres returns int8 as a string to
// avoid silent precision loss; these amounts are minor units well inside
// Number.MAX_SAFE_INTEGER, so parsing is safe and keeps the types simple.
pg.types.setTypeParser(20, (v: string) => Number(v));

// 200 concurrent holds on one slot means 199 transactions sitting inside the
// exclusion constraint's wait, each holding a pool client until the winner
// commits. At max 10 the eleventh request could not get a connection at all and
// timed out as a 500 -- the proof failed on plumbing, not on the invariant.
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
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
 * Runs fn inside a transaction, translating Postgres error codes at this
 * boundary so nothing above sees a raw driver exception.
 *
 * The actor and reason are set with set_config(..., true), which is SET LOCAL
 * and therefore scoped to this transaction. They are read by the audit trigger.
 * Transaction scope matters: a session-level setting would survive on a pooled
 * connection and attribute the next request's audit rows to this actor.
 */
export async function withTransaction<T>(
  actor: ActorContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  // A GiST exclusion constraint under real concurrency produces genuine
  // deadlocks, and the first 200-request run proved it: two inserts each place
  // their index entry, then each scans, finds the other, and waits on the
  // other's transaction. Postgres shoots one of them with 40P01. The victim is
  // rolled back completely -- nothing it wrote survives -- so replaying it is
  // safe, and it must not surface as a 500: a deadlock here is a lost race,
  // which the brief requires to be a clean 409.
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

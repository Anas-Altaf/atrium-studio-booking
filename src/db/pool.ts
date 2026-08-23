import pg from 'pg';
import { config } from '../config.js';
import { translatePgError } from '../errors.js';

// Money is bigint in the database. node-postgres returns int8 as a string to
// avoid silent precision loss; these amounts are minor units well inside
// Number.MAX_SAFE_INTEGER, so parsing is safe and keeps the types simple.
pg.types.setTypeParser(20, (v: string) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export type Tx = pg.PoolClient;

export interface ActorContext {
  actorId: string | null;
  reason: string;
}

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
    throw translatePgError(err) ?? err;
  } finally {
    client.release();
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

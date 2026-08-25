/** Worker functions take no AuthScope: the worker has no caller and no tenant. */
import type { Tx } from '../db/pool.js';

export interface RefundRow {
  id: string;
  booking_id: string;
  payment_id: string;
  amount_minor: number;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  reason: string;
  idempotency_key: string;
  provider_refund_id: string | null;
  attempts: number;
}

const COLUMNS = `id, booking_id, payment_id, amount_minor, status, reason,
                 idempotency_key, provider_refund_id, attempts`;

/** Live is PENDING or SUCCEEDED — the same predicate as one_live_refund_per_booking. */
export async function findLive(tx: Tx, bookingId: string): Promise<RefundRow | undefined> {
  const { rows } = await tx.query<RefundRow>(
    `SELECT ${COLUMNS} FROM refunds
     WHERE  booking_id = $1 AND status IN ('PENDING','SUCCEEDED')`,
    [bookingId],
  );
  return rows[0];
}

/**
 * The intent, written in the same transaction as the transition that caused it.
 * Both commit or neither, so money owed cannot outlive the decision to owe it.
 */
export async function intend(tx: Tx, refund: {
  bookingId: string;
  paymentId: string;
  amountMinor: number;
  reason: string;
}): Promise<RefundRow> {
  const { rows } = await tx.query<RefundRow>(
    `INSERT INTO refunds (booking_id, payment_id, amount_minor, reason, idempotency_key)
     VALUES ($1, $2, $3, $4, gen_random_uuid())
     RETURNING ${COLUMNS}`,
    [refund.bookingId, refund.paymentId, refund.amountMinor, refund.reason],
  );
  return rows[0]!;
}

export async function claimDue(tx: Tx, limit: number): Promise<RefundRow[]> {
  const { rows } = await tx.query<RefundRow>(
    `SELECT ${COLUMNS} FROM refunds
     WHERE  status = 'PENDING' AND provider_refund_id IS NULL AND next_attempt_at <= now()
     ORDER  BY next_attempt_at
     FOR    UPDATE SKIP LOCKED
     LIMIT  $1`,
    [limit],
  );
  return rows;
}

export async function attachProviderId(
  tx: Tx, refundId: string, providerRefundId: string,
): Promise<void> {
  await tx.query(
    `UPDATE refunds SET provider_refund_id = $2, updated_at = now() WHERE id = $1`,
    [refundId, providerRefundId],
  );
}

/** Exponential backoff, capped at five minutes. */
export async function defer(tx: Tx, refundId: string, attempts: number): Promise<void> {
  await tx.query(
    `UPDATE refunds
     SET    attempts = attempts + 1,
            next_attempt_at = now() + ($2 || ' seconds')::interval,
            updated_at = now()
     WHERE  id = $1`,
    [refundId, String(Math.min(2 ** attempts, 300))],
  );
}

/** Guarded on PENDING, so a redelivered refund webhook updates nothing. */
export async function settle(
  tx: Tx, refundId: string, status: 'SUCCEEDED' | 'FAILED',
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE refunds SET status = $2, updated_at = now()
     WHERE  id = $1 AND status = 'PENDING'`,
    [refundId, status],
  );
  return (rowCount ?? 0) > 0;
}

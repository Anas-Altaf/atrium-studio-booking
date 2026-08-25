/** Worker functions take no AuthScope: the worker has no caller and no tenant. */
import type { Tx } from '../db/pool.js';

export interface PaymentRow {
  id: string;
  booking_id: string;
  charge_id: string | null;
  idempotency_key: string;
  status: 'PENDING' | 'CAPTURED' | 'FAILED' | 'REFUNDED';
  amount_minor: number;
  currency: string;
}

const COLUMNS = `id, booking_id, charge_id, idempotency_key, status, amount_minor, currency`;

/** Live is PENDING or CAPTURED — the same predicate as one_live_charge_per_booking. */
export async function findLive(tx: Tx, bookingId: string): Promise<PaymentRow | undefined> {
  const { rows } = await tx.query<PaymentRow>(
    `SELECT ${COLUMNS} FROM payments
     WHERE  booking_id = $1 AND status IN ('PENDING','CAPTURED')`,
    [bookingId],
  );
  return rows[0];
}

/**
 * INV-3 at the database level: the partial unique index refuses a second live
 * charge however two callers are scheduled. The key is persisted before any
 * outbound call exists, so a retry reuses it.
 */
export async function insertPending(
  tx: Tx, booking: { id: string; amountMinor: number; currency?: string },
): Promise<PaymentRow> {
  const { rows } = await tx.query<PaymentRow>(
    `INSERT INTO payments (booking_id, idempotency_key, amount_minor, currency)
     VALUES ($1, gen_random_uuid(), $2, $3)
     RETURNING ${COLUMNS}`,
    [booking.id, booking.amountMinor, booking.currency ?? 'PKR'],
  );
  return rows[0]!;
}

/**
 * The job queue is the payment row itself (4D). A separate queue would make
 * enqueueing a second write, and a crash between the two would lose a charge.
 * SKIP LOCKED so three replicas take disjoint work.
 */
export async function claimUnsubmitted(tx: Tx, limit: number): Promise<PaymentRow[]> {
  const { rows } = await tx.query<PaymentRow>(
    `SELECT ${COLUMNS} FROM payments
     WHERE  status = 'PENDING' AND charge_id IS NULL
     ORDER  BY created_at
     FOR    UPDATE SKIP LOCKED
     LIMIT  $1`,
    [limit],
  );
  return rows;
}

export async function attachChargeId(
  tx: Tx, paymentId: string, chargeId: string,
): Promise<void> {
  await tx.query(
    `UPDATE payments SET charge_id = $2, updated_at = now() WHERE id = $1`,
    [paymentId, chargeId],
  );
}

export async function findByChargeId(
  tx: Tx, chargeId: string,
): Promise<PaymentRow | undefined> {
  const { rows } = await tx.query<PaymentRow>(
    `SELECT ${COLUMNS} FROM payments WHERE charge_id = $1 FOR UPDATE`,
    [chargeId],
  );
  return rows[0];
}

/** Guarded on PENDING, so a redelivery updates nothing. The row count says which happened. */
export async function settle(
  tx: Tx, paymentId: string, status: 'CAPTURED' | 'FAILED',
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE payments SET status = $2, updated_at = now()
     WHERE  id = $1 AND status = 'PENDING'`,
    [paymentId, status],
  );
  return (rowCount ?? 0) > 0;
}

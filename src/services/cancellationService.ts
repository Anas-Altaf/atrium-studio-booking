/**
 * The cancellation is what is made idempotent, not the refund: CONFIRMED ->
 * CANCELLED serialises under the row lock and the trigger, and the refund
 * intent is written in the same transaction, so both commit or neither (4C).
 */
import { withTransaction } from '../db/pool.js';
import type { AuthScope } from '../auth/scope.js';
import { conflict, notFound } from '../errors.js';
import { hoursBetween } from '../domain/booking.js';
import { calculateRefund, equipmentPortion, splitTotal } from '../domain/refund.js';
import * as bookingRepo from '../repositories/bookingRepo.js';
import * as paymentRepo from '../repositories/paymentRepo.js';
import * as refundRepo from '../repositories/refundRepo.js';
import * as venueRepo from '../repositories/venueRepo.js';

export interface Cancellation {
  bookingId: string;
  status: string;
  refund: { id: string; amountMinor: number; status: string } | null;
  /** False when this call found the booking already cancelled. */
  cancelled: boolean;
}

const CANCELLABLE = new Set(['HELD', 'PENDING_PAYMENT', 'CONFIRMED']);

export async function cancel(scope: AuthScope, bookingId: string): Promise<Cancellation> {
  const visible = await bookingRepo.findById(scope, bookingId);
  if (!visible) throw notFound('booking not found');

  return withTransaction({ actorId: scope.userId, reason: 'cancelled' }, async (tx) => {
    const booking = await bookingRepo.lockById(tx, bookingId);
    if (!booking) throw notFound('booking not found');

    // A repeat cancel is a replay, not a conflict: the same answer, including
    // the refund the first call created (A11).
    const existing = await refundRepo.findLive(tx, bookingId);
    if (booking.status === 'CANCELLED' || booking.status === 'REFUNDED') {
      return { bookingId, status: booking.status, refund: describe(existing), cancelled: false };
    }

    if (!CANCELLABLE.has(booking.status)) {
      throw conflict('NOT_CANCELLABLE', `A ${booking.status} booking cannot be cancelled.`);
    }

    await bookingRepo.transition(tx, bookingId, booking.status, 'CANCELLED');

    // Only money already taken can be returned. A hold that was never charged
    // releases its slot and ends there.
    const payment = await paymentRepo.findLive(tx, bookingId);
    if (!payment || payment.status !== 'CAPTURED') {
      return { bookingId, status: 'CANCELLED', refund: null, cancelled: true };
    }

    const refund = await intendRefund(tx, booking, payment.id);
    return { bookingId, status: 'CANCELLED', refund: describe(refund), cancelled: true };
  });
}

async function intendRefund(
  tx: import('../db/pool.js').Tx,
  booking: { id: string; start_at: Date; end_at: Date; total_minor: number; policy_version_id: string },
  paymentId: string,
) {
  // Through the booking's own version, never the venue's current pointer.
  const tiers = await venueRepo.tiersOf(tx, booking.policy_version_id);
  const lines = await bookingRepo.lineItems(tx, booking.id);

  const hours = hoursBetween(booking.start_at.toISOString(), booking.end_at.toISOString());
  const { roomMinor, equipmentMinor } = splitTotal(
    booking.total_minor, equipmentPortion(lines, hours),
  );

  const due = calculateRefund(tiers, booking.start_at, roomMinor, equipmentMinor);
  if (due.totalMinor === 0) return undefined;

  return refundRepo.intend(tx, {
    bookingId: booking.id,
    paymentId,
    amountMinor: due.totalMinor,
    reason: due.tier
      ? `cancelled more than ${due.tier.hours_before}h before start`
      : 'cancelled',
  });
}

const describe = (refund?: { id: string; amount_minor: number; status: string }) =>
  (refund ? { id: refund.id, amountMinor: refund.amount_minor, status: refund.status } : null);

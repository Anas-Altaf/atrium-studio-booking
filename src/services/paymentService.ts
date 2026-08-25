/**
 * Writes the payment row and moves the booking in one transaction; the worker
 * submits it to Paygate. Calling the provider inline after the commit would be
 * the dual write §4D rejects — a crash between the two loses a charge.
 */
import { withTransaction } from '../db/pool.js';
import type { AuthScope } from '../auth/scope.js';
import { badRequest, conflict, notFound } from '../errors.js';
import * as bookingRepo from '../repositories/bookingRepo.js';
import * as paymentRepo from '../repositories/paymentRepo.js';
import type { PaymentRow } from '../repositories/paymentRepo.js';

export interface PaymentAccepted {
  payment: PaymentRow;
  /** False when this call found a charge that already existed. */
  created: boolean;
}

export async function submitForPayment(
  scope: AuthScope, bookingId: string,
): Promise<PaymentAccepted> {
  // Scoped read first: paying for a booking must not reveal that it exists.
  const visible = await bookingRepo.findById(scope, bookingId);
  if (!visible) throw notFound('booking not found');

  return withTransaction({ actorId: scope.userId, reason: 'payment submitted' }, async (tx) => {
    const booking = await bookingRepo.lockById(tx, bookingId);
    if (!booking) throw notFound('booking not found');

    // INV-3. The database would refuse a second live charge anyway; this
    // returns the existing one rather than surfacing the constraint as a 409.
    const existing = await paymentRepo.findLive(tx, bookingId);
    if (existing) return { payment: existing, created: false };

    if (booking.status !== 'HELD') {
      throw conflict('NOT_PAYABLE',
        `A booking is submitted for payment from HELD, not ${booking.status}.`);
    }

    // A hold past its TTL is still HELD until the reaper moves it. Charging it
    // creates money against a slot about to be released.
    if (booking.expires_at && booking.expires_at.getTime() <= Date.now()) {
      throw badRequest('HOLD_EXPIRED', 'That hold has expired. Take the slot again.');
    }

    const payment = await paymentRepo.insertPending(tx, {
      id: bookingId, amountMinor: booking.total_minor,
    });
    await bookingRepo.transition(tx, bookingId, 'HELD', 'PENDING_PAYMENT');

    return { payment, created: true };
  });
}

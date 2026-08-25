/**
 * Plain functions, not timers. The loop calls them and so do the tests — a job
 * wrapped in a timer can only be tested by waiting for it.
 *
 * Every job claims its batch with SKIP LOCKED, so all three replicas can run
 * them at once and take disjoint work.
 */
import { config } from '../config.js';
import { withTransaction } from '../db/pool.js';
import type { Tx } from '../db/pool.js';
import * as bookingRepo from '../repositories/bookingRepo.js';
import * as paymentRepo from '../repositories/paymentRepo.js';
import * as refundRepo from '../repositories/refundRepo.js';
import * as webhookRepo from '../repositories/webhookRepo.js';

export interface JobLogger {
  info: (o: Record<string, unknown>, m: string) => void;
  warn: (o: Record<string, unknown>, m: string) => void;
}

const silent: JobLogger = { info: () => {}, warn: () => {} };

/** A provider that never answers must not hold a transaction open behind it. */
const PROVIDER_TIMEOUT_MS = 5_000;

export async function submitPendingCharges(
  log: JobLogger = silent, limit = config.workerBatchSize,
): Promise<number> {
  let submitted = 0;

  for (let i = 0; i < limit; i++) {
    const result = await submitOne(log);
    if (result === 'empty') break;
    if (result === 'submitted') submitted++;
  }

  return submitted;
}

/**
 * One payment per transaction, because the call to the provider happens inside
 * it. Batching them meant a single transaction held its connection and its row
 * locks across twenty sequential HTTP calls.
 *
 * The lock is held across the call so two replicas do not both submit, but that
 * is an optimisation rather than the guarantee: the idempotency key travels
 * with the row, so even a double submission returns the same charge.
 */
async function submitOne(log: JobLogger): Promise<'submitted' | 'failed' | 'empty'> {
  return withTransaction({ actorId: null, reason: 'charge submitted' }, async (tx) => {
    const [payment] = await paymentRepo.claimUnsubmitted(tx, 1);
    if (!payment) return 'empty';

    try {
      const res = await fetch(`${config.paygateUrl}/paygate/charges`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': payment.idempotency_key,
        },
        body: JSON.stringify({
          amount_minor: payment.amount_minor,
          currency: payment.currency,
          reference: payment.booking_id,
        }),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });

      if (!res.ok) {
        log.warn({ payment: payment.id, status: res.status }, 'charge submission failed');
        return 'failed';
      }

      const body = await res.json() as { charge_id?: string };
      if (!body.charge_id) {
        log.warn({ payment: payment.id }, 'provider returned no charge id');
        return 'failed';
      }

      await paymentRepo.attachChargeId(tx, payment.id, body.charge_id);
      return 'submitted';
    } catch (err) {
      log.warn({ payment: payment.id, err: (err as Error).message }, 'provider unreachable');
      return 'failed';
    }
  });
}

/**
 * Expires holds past their TTL, including those in PENDING_PAYMENT.
 *
 * Nothing expires by the passage of time: the exclusion constraint's WHERE
 * cannot reference now(), so a hold past its TTL keeps blocking its slot until
 * this moves it. Batched, so a backlog drains over several ticks rather than in
 * one statement.
 */
export async function reapHolds(
  log: JobLogger = silent, limit = config.workerBatchSize,
): Promise<number> {
  return withTransaction({ actorId: null, reason: 'hold TTL elapsed' }, async (tx) => {
    const expired = await bookingRepo.claimExpired(tx, limit);
    let reaped = 0;

    for (const booking of expired) {
      // Through the trigger, so each expiry is validated and audited.
      if (await bookingRepo.transition(tx, booking.id, booking.status, 'EXPIRED')) reaped++;
    }

    if (reaped) log.info({ reaped }, 'holds expired');
    return reaped;
  });
}

/**
 * Drives refund intents to the provider. Same shape as submitOne: one per
 * transaction, with a timeout, so a hung provider holds no locks.
 */
export async function driveRefunds(
  log: JobLogger = silent, limit = config.workerBatchSize,
): Promise<number> {
  let submitted = 0;

  for (let i = 0; i < limit; i++) {
    const result = await refundOne(log);
    if (result === 'empty') break;
    if (result === 'submitted') submitted++;
  }

  return submitted;
}

async function refundOne(log: JobLogger): Promise<'submitted' | 'failed' | 'empty'> {
  return withTransaction({ actorId: null, reason: 'refund submitted' }, async (tx) => {
    const [refund] = await refundRepo.claimDue(tx, 1);
    if (!refund) return 'empty';

    const payment = await paymentRepo.findById(tx, refund.payment_id);
    if (!payment?.charge_id) {
      // The charge was never submitted. Nothing to refund against yet.
      await refundRepo.defer(tx, refund.id, refund.attempts);
      return 'failed';
    }

    try {
      const res = await fetch(`${config.paygateUrl}/paygate/refunds`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': refund.id,
        },
        body: JSON.stringify({
          charge_id: payment.charge_id,
          amount_minor: refund.amount_minor,
        }),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });

      if (!res.ok) {
        log.warn({ refund: refund.id, status: res.status }, 'refund submission failed');
        await refundRepo.defer(tx, refund.id, refund.attempts);
        return 'failed';
      }

      const body = await res.json() as { refund_id?: string };
      if (!body.refund_id) {
        await refundRepo.defer(tx, refund.id, refund.attempts);
        return 'failed';
      }

      await refundRepo.attachProviderId(tx, refund.id, body.refund_id);
      return 'submitted';
    } catch (err) {
      log.warn({ refund: refund.id, err: (err as Error).message }, 'provider unreachable');
      await refundRepo.defer(tx, refund.id, refund.attempts);
      return 'failed';
    }
  });
}

/**
 * Idempotent on the business effect, not on the delivery. Both the settle and
 * the transition are guarded on current state, so a redelivery updates nothing
 * and is marked processed.
 */
export async function processWebhooks(
  log: JobLogger = silent, limit = config.workerBatchSize,
): Promise<number> {
  return withTransaction({ actorId: null, reason: 'webhook applied' }, async (tx) => {
    const events = await webhookRepo.claimDue(tx, limit);
    let applied = 0;

    for (const event of events) {
      const payment = await paymentRepo.findByChargeId(tx, event.charge_id);

      if (!payment) {
        await webhookRepo.recordUnmatched(tx, event.charge_id, event.payload);
        await webhookRepo.markProcessed(tx, event.id);
        log.info({ charge: event.charge_id }, 'webhook for an unknown charge, parked');
        continue;
      }

      try {
        await apply(tx, event.event_type, payment.id, payment.booking_id, log);
        await webhookRepo.markProcessed(tx, event.id);
        applied++;
      } catch (err) {
        await webhookRepo.defer(tx, event.id, event.attempts, (err as Error).message);
        log.warn({ event: event.id, err: (err as Error).message }, 'webhook deferred');
      }
    }

    return applied;
  });
}

async function apply(
  tx: Tx, eventType: string, paymentId: string, bookingId: string, log: JobLogger,
): Promise<void> {
  switch (eventType) {
    case 'charge.succeeded': return capture(tx, paymentId, bookingId, log);
    case 'charge.failed': {
      if (!await paymentRepo.settle(tx, paymentId, 'FAILED')) return;
      await bookingRepo.transition(tx, bookingId, 'PENDING_PAYMENT', 'FAILED');
      return;
    }
    case 'refund.succeeded': return refunded(tx, bookingId, log);
    default:
      log.info({ eventType }, 'no handler for event type');
  }
}

/**
 * INV-4. The capture is real money either way, so it is recorded either way.
 * What varies is where it goes: a booking still in PENDING_PAYMENT is
 * confirmed, and one the reaper has already expired is refunded.
 *
 * The transition's own guard decides which. Reading the status and then acting
 * would leave a window for the reaper to run in between; the UPDATE either
 * matches PENDING_PAYMENT or it does not.
 */
async function capture(
  tx: Tx, paymentId: string, bookingId: string, log: JobLogger,
): Promise<void> {
  if (!await paymentRepo.settle(tx, paymentId, 'CAPTURED')) return;

  if (await bookingRepo.transition(tx, bookingId, 'PENDING_PAYMENT', 'CONFIRMED')) return;

  const booking = await bookingRepo.lockById(tx, bookingId);
  if (!booking) return;

  // A refund already live means this has been handled.
  if (await refundRepo.findLive(tx, bookingId)) return;

  const payment = await paymentRepo.findById(tx, paymentId);
  await refundRepo.intend(tx, {
    bookingId,
    paymentId,
    amountMinor: payment?.amount_minor ?? booking.total_minor,
    reason: `capture arrived while the booking was ${booking.status}`,
  });
  log.info({ bookingId, status: booking.status }, 'capture on an unconfirmable booking, refunding');
}

/** The provider returned the money. The booking follows it to REFUNDED. */
async function refunded(tx: Tx, bookingId: string, log: JobLogger): Promise<void> {
  const refund = await refundRepo.findLive(tx, bookingId);
  if (!refund || !await refundRepo.settle(tx, refund.id, 'SUCCEEDED')) return;

  const booking = await bookingRepo.lockById(tx, bookingId);
  if (!booking) return;

  // Both CANCELLED and EXPIRED reach REFUNDED in the matrix; which one this is
  // depends on whether a customer cancelled or the hold ran out.
  if (!await bookingRepo.transition(tx, bookingId, booking.status, 'REFUNDED')) {
    log.warn({ bookingId, status: booking.status }, 'refund settled on an unrefundable state');
  }
}

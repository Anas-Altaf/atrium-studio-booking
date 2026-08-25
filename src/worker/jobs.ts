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

/**
 * A capture landing on a booking that is no longer PENDING_PAYMENT is left
 * alone: the transition does not apply, so an expired booking is never
 * confirmed. Refunding it is INV-4, and arrives with the reaper in M3.
 */
async function apply(
  tx: Tx, eventType: string, paymentId: string, bookingId: string, log: JobLogger,
): Promise<void> {
  switch (eventType) {
    case 'charge.succeeded': {
      if (!await paymentRepo.settle(tx, paymentId, 'CAPTURED')) return;
      await bookingRepo.transition(tx, bookingId, 'PENDING_PAYMENT', 'CONFIRMED');
      return;
    }
    case 'charge.failed': {
      if (!await paymentRepo.settle(tx, paymentId, 'FAILED')) return;
      await bookingRepo.transition(tx, bookingId, 'PENDING_PAYMENT', 'FAILED');
      return;
    }
    default:
      log.info({ eventType }, 'no handler for event type');
  }
}

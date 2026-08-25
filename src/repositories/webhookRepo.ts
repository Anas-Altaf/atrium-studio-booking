/** Worker functions take no AuthScope: the worker has no caller and no tenant. */
import { query } from '../db/pool.js';
import type { Tx } from '../db/pool.js';

export interface WebhookEventRow {
  id: string;
  charge_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  correlation_id: string | null;
  attempts: number;
}

/**
 * Deduplicates on the business event, not on `X-Paygate-Delivery`, which the
 * provider's specification says is new on every attempt.
 *
 * Returns false when the event was already recorded. The caller answers 200
 * either way: a non-2xx earns a redelivery of something already held.
 */
export async function record(event: {
  chargeId: string;
  eventType: string;
  deliveryId: string | null;
  payload: unknown;
  correlationId: string | null;
}): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `INSERT INTO webhook_events (charge_id, event_type, delivery_id, payload, correlation_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (charge_id, event_type) DO NOTHING
     RETURNING id`,
    [event.chargeId, event.eventType, event.deliveryId, JSON.stringify(event.payload),
     event.correlationId],
  );
  return rows.length > 0;
}

export async function claimDue(tx: Tx, limit: number): Promise<WebhookEventRow[]> {
  const { rows } = await tx.query<WebhookEventRow>(
    `SELECT id, charge_id, event_type, payload, correlation_id, attempts
     FROM   webhook_events
     WHERE  processed_at IS NULL AND next_attempt_at <= now()
     ORDER  BY received_at
     FOR    UPDATE SKIP LOCKED
     LIMIT  $1`,
    [limit],
  );
  return rows;
}

export async function markProcessed(tx: Tx, id: string): Promise<void> {
  await tx.query(
    `UPDATE webhook_events SET processed_at = now(), last_error = NULL WHERE id = $1`,
    [id],
  );
}

/** Exponential backoff, capped at five minutes. The reason is kept so a stuck event can be explained. */
export async function defer(tx: Tx, id: string, attempts: number, error: string): Promise<void> {
  const backoffSeconds = Math.min(2 ** attempts, 300);
  await tx.query(
    `UPDATE webhook_events
     SET    attempts = attempts + 1,
            next_attempt_at = now() + ($2 || ' seconds')::interval,
            last_error = $3
     WHERE  id = $1`,
    [id, String(backoffSeconds), error.slice(0, 500)],
  );
}

/**
 * A delivery naming a charge we have not recorded. Expected, not exceptional:
 * the provider races 25% of callbacks ahead of the 202, and answers 500 on 10%
 * of submissions having already created the charge.
 */
export async function recordUnmatched(
  tx: Tx, chargeId: string, payload: unknown,
): Promise<void> {
  await tx.query(
    `INSERT INTO unmatched_webhooks (charge_id, payload) VALUES ($1, $2)`,
    [chargeId, JSON.stringify(payload)],
  );
}

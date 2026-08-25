/**
 * Verify, record, answer. No work on this thread: the provider redelivers
 * whatever it does not get a fast 200 for, so slow processing turns one event
 * into several. The worker does the rest, from the row this writes.
 */
import { z } from 'zod';
import { config } from '../config.js';
import { unauthorized } from '../errors.js';
import { signatureMatches } from '../paygate/server.js';
import * as webhookRepo from '../repositories/webhookRepo.js';

const envelope = z.object({
  charge_id: z.string().min(1),
  event: z.string().min(1),
});

export interface IntakeResult {
  /** False when the event had already been recorded. Still answered 200. */
  recorded: boolean;
}

export async function intake(input: {
  rawBody: string;
  signature: string | undefined;
  deliveryId: string | null;
  correlationId: string | null;
}): Promise<IntakeResult> {
  // Checked against the raw bytes before anything parses them. Re-serialising
  // to verify would fail on key order alone.
  if (!input.signature
      || !signatureMatches(input.rawBody, config.paygateSecret, input.signature)) {
    throw unauthorized('signature does not match');
  }

  const body = envelope.parse(JSON.parse(input.rawBody));

  const recorded = await webhookRepo.record({
    chargeId: body.charge_id,
    eventType: body.event,
    deliveryId: input.deliveryId,
    payload: JSON.parse(input.rawBody),
    correlationId: input.correlationId,
  });

  return { recorded };
}

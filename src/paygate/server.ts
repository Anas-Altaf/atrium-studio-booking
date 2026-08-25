/**
 * The mock provider, built to section 06 of the brief and deliberately
 * unreliable. State is in memory: a mock need not survive a restart, and a
 * database would make it look like part of the system under test.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Forced, planFor, seededRandom, signatureIsBad } from './chaos.js';

export interface PaygateOptions {
  secret: string;
  callbackUrl: string;
  chaos: boolean;
  seed?: number;
  /** Scales every delay, so tests do not wait 60 seconds for a late delivery. */
  timeScale?: number;
}

interface Charge {
  chargeId: string;
  reference: string;
  amountMinor: number;
  currency: string;
  status: 'processing' | 'succeeded' | 'failed';
  idempotencyKey: string;
  occurredAt: string;
}

interface Refund {
  refundId: string;
  chargeId: string;
  amountMinor: number;
  idempotencyKey: string;
}

const chargeBody = z.object({
  amount_minor: z.number().int().positive(),
  currency: z.string().min(1).default('PKR'),
  reference: z.string().min(1),
});

const refundBody = z.object({
  charge_id: z.string().min(1),
  amount_minor: z.number().int().nonnegative(),
});

export function buildPaygate(opts: PaygateOptions): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  const rand = seededRandom(opts.seed ?? 1_337);
  const scale = opts.timeScale ?? 1;

  const chargesById = new Map<string, Charge>();
  const chargesByKey = new Map<string, string>();
  const refundsByKey = new Map<string, Refund>();

  // Every scheduled delivery is tracked so close() can cancel it. Without this
  // a test that triggers a 60 second delivery holds the process open.
  const timers = new Set<NodeJS.Timeout>();

  app.addHook('onClose', async () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  });

  /**
   * The transient failure creates the charge and schedules its webhook before
   * answering 500, so the caller holds a charge it has no id for — which is how
   * a real provider fails after taking a request, and what exercises the
   * unmatched-webhook path. A retry with the same key returns the original.
   */
  app.post('/paygate/charges', async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0) {
      return reply.code(400).send({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
    }

    const body = chargeBody.parse(req.body);
    const forced = forcedFrom(req.headers['x-paygate-force']);

    const existingId = chargesByKey.get(key);
    if (existingId) {
      const existing = chargesById.get(existingId)!;
      return reply.code(202).send({ charge_id: existing.chargeId, status: 'processing' });
    }

    const plan = planFor(forced, opts.chaos, rand);

    const charge: Charge = {
      chargeId: `ch_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      reference: body.reference,
      amountMinor: body.amount_minor,
      currency: body.currency,
      status: 'processing',
      idempotencyKey: key,
      occurredAt: new Date().toISOString(),
    };
    chargesById.set(charge.chargeId, charge);
    chargesByKey.set(key, charge.chargeId);

    const event = plan.declined ? 'charge.failed' : 'charge.succeeded';
    charge.status = plan.declined ? 'failed' : 'succeeded';

    schedule(() => deliver({
      charge_id: charge.chargeId,
      reference: charge.reference,
      event,
      amount_minor: charge.amountMinor,
      occurred_at: charge.occurredAt,
    }, plan.duplicate, forced), plan.delayMs);

    if (plan.transient) {
      return reply.code(500).send({ error: 'PROVIDER_UNAVAILABLE' });
    }

    // The webhook is already on its way; the 202 is held back so it lands after.
    if (plan.race) await sleep(150 * scale);

    return reply.code(202).send({ charge_id: charge.chargeId, status: 'processing' });
  });

  /** POST /paygate/refunds — same idempotency contract as charges. */
  app.post('/paygate/refunds', async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0) {
      return reply.code(400).send({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
    }

    const body = refundBody.parse(req.body);
    const forced = forcedFrom(req.headers['x-paygate-force']);

    const existing = refundsByKey.get(key);
    if (existing) {
      return reply.code(202).send({ refund_id: existing.refundId, status: 'processing' });
    }

    const charge = chargesById.get(body.charge_id);
    if (!charge) return reply.code(404).send({ error: 'UNKNOWN_CHARGE' });

    const refund: Refund = {
      refundId: `rf_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      chargeId: charge.chargeId,
      amountMinor: body.amount_minor,
      idempotencyKey: key,
    };
    refundsByKey.set(key, refund);

    const plan = planFor(forced, opts.chaos, rand);

    schedule(() => deliver({
      charge_id: charge.chargeId,
      refund_id: refund.refundId,
      reference: charge.reference,
      event: 'refund.succeeded',
      amount_minor: refund.amountMinor,
      occurred_at: new Date().toISOString(),
    }, plan.duplicate, forced), plan.delayMs);

    return reply.code(202).send({ refund_id: refund.refundId, status: 'processing' });
  });

  /** Not in the spec. For debugging and for asserting in tests. */
  app.get<{ Params: { id: string } }>('/paygate/charges/:id', async (req, reply) => {
    const charge = chargesById.get(req.params.id);
    if (!charge) return reply.code(404).send({ error: 'UNKNOWN_CHARGE' });
    return charge;
  });

  app.get('/health', async () => ({
    status: 'ok', chaos: opts.chaos, charges: chargesById.size, callback: opts.callbackUrl,
  }));

  function schedule(fn: () => void, delayMs: number): void {
    const t = setTimeout(() => { timers.delete(t); fn(); }, Math.round(delayMs * scale));
    timers.add(t);
  }

  async function deliver(
    payload: Record<string, unknown>,
    duplicate: boolean,
    forced: Forced | undefined,
  ): Promise<void> {
    await attempt(payload, forced);
    // A second attempt carries a new delivery id and rolls its own signature,
    // so one copy can be forged while the other is genuine.
    if (duplicate) schedule(() => { void attempt(payload, forced); }, 40);
  }

  async function attempt(
    payload: Record<string, unknown>,
    forced: Forced | undefined,
  ): Promise<void> {
    const raw = JSON.stringify(payload);
    const bad = signatureIsBad(forced, opts.chaos, rand);
    const signature = bad ? sign(raw, `${opts.secret}-wrong`) : sign(raw, opts.secret);
    const delivery = randomUUID();

    try {
      const res = await fetch(opts.callbackUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-paygate-signature': signature,
          'x-paygate-delivery': delivery,
        },
        body: raw,
      });
      app.log.info(
        { delivery, status: res.status, forged: bad, charge: payload.charge_id },
        'webhook delivered',
      );
    } catch (err) {
      // A provider does not care that the merchant was down. Logged, dropped.
      app.log.warn({ delivery, err: (err as Error).message }, 'webhook delivery failed');
    }
  }

  return app;
}

export function sign(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** Constant time, so a signature cannot be recovered a byte at a time. */
export function signatureMatches(rawBody: string, secret: string, given: string): boolean {
  const expected = Buffer.from(sign(rawBody, secret), 'utf8');
  const actual = Buffer.from(given, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function forcedFrom(header: unknown): Forced | undefined {
  return typeof header === 'string' ? (header as Forced) : undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

const isEntry = process.argv[1]?.includes('paygate');

if (isEntry) {
  const app = buildPaygate({
    secret: process.env.PAYGATE_SECRET ?? 'paygate-dev-secret',
    callbackUrl: process.env.PAYGATE_CALLBACK_URL ?? 'http://localhost:3000/webhooks/paygate',
    chaos: process.env.PAYGATE_CHAOS === 'on',
    seed: process.env.PAYGATE_SEED ? Number(process.env.PAYGATE_SEED) : undefined,
  });
  try {
    await app.listen({
      port: Number(process.env.PAYGATE_PORT ?? 4000),
      host: process.env.HOST ?? '0.0.0.0',
    });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

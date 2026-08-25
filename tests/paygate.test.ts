/**
 * Paygate against a stub receiver, over real HTTP. Every assertion here is
 * about the provider's behaviour, not ours.
 *
 * Chaos is forced by header. Waiting for a 30% duplicate to fire is flaky, and
 * raising the rate to 100% tests a configuration that never ships.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildPaygate, sign, signatureMatches } from '../src/paygate/server.js';

const SECRET = 'test-secret';

interface Delivery {
  raw: string;
  signature: string;
  deliveryId: string;
  body: Record<string, unknown>;
}

let paygate: FastifyInstance;
let receiver: FastifyInstance;
let paygateUrl: string;
let received: Delivery[] = [];

beforeAll(async () => {
  receiver = Fastify({ logger: false });
  // The signature covers the raw bytes, so the receiver must keep them. Parsing
  // first and re-serialising would change key order and break every check.
  receiver.addContentTypeParser(
    'application/json', { parseAs: 'string' },
    (_req, body, done) => { done(null, { raw: body as string }); },
  );
  receiver.post('/webhooks/paygate', async (req, reply) => {
    const { raw } = req.body as { raw: string };
    received.push({
      raw,
      signature: String(req.headers['x-paygate-signature'] ?? ''),
      deliveryId: String(req.headers['x-paygate-delivery'] ?? ''),
      body: JSON.parse(raw),
    });
    return reply.code(200).send({ ok: true });
  });
  await receiver.listen({ port: 0, host: '127.0.0.1' });

  const receiverPort = (receiver.server.address() as { port: number }).port;

  paygate = buildPaygate({
    secret: SECRET,
    callbackUrl: `http://127.0.0.1:${receiverPort}/webhooks/paygate`,
    chaos: false,
    seed: 99,
    // A forced "delayed" is 60 seconds of wall clock. Scaled down, it is still
    // the same code path.
    timeScale: 0.001,
  });
  await paygate.listen({ port: 0, host: '127.0.0.1' });
  paygateUrl = `http://127.0.0.1:${(paygate.server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await paygate.close();
  await receiver.close();
});

async function charge(
  reference: string,
  key: string,
  force?: string,
): Promise<{ status: number; body: Record<string, string> }> {
  const res = await fetch(`${paygateUrl}/paygate/charges`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      ...(force ? { 'x-paygate-force': force } : {}),
    },
    body: JSON.stringify({ amount_minor: 45_000, currency: 'PKR', reference }),
  });
  return { status: res.status, body: await res.json() as Record<string, string> };
}

/** Deliveries are asynchronous by design; this waits for them rather than sleeping blind. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => { setTimeout(r, 20); });
  }
  throw new Error('timed out waiting for deliveries');
}

const forCharge = (id: string) => received.filter((d) => d.body.charge_id === id);

describe('charges', () => {
  it('returns 202 with a charge id and delivers a signed webhook', async () => {
    received = [];
    const { status, body } = await charge('booking-1', 'key-1');

    expect(status).toBe(202);
    expect(body.charge_id).toMatch(/^ch_/);
    expect(body.status).toBe('processing');

    await waitFor(() => forCharge(body.charge_id).length === 1);

    const [delivery] = forCharge(body.charge_id);
    expect(delivery!.body.event).toBe('charge.succeeded');
    expect(delivery!.body.reference).toBe('booking-1');
    expect(delivery!.body.amount_minor).toBe(45_000);
    expect(delivery!.deliveryId).toBeTruthy();
    expect(signatureMatches(delivery!.raw, SECRET, delivery!.signature)).toBe(true);
  });

  it('rejects a charge with no Idempotency-Key', async () => {
    const res = await fetch(`${paygateUrl}/paygate/charges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount_minor: 1_000, currency: 'PKR', reference: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  it('a retry with the same key returns the same charge, not a second one', async () => {
    received = [];
    const first = await charge('booking-2', 'key-2');
    const second = await charge('booking-2', 'key-2');

    expect(second.status).toBe(202);
    expect(second.body.charge_id).toBe(first.body.charge_id);

    await waitFor(() => forCharge(first.body.charge_id).length >= 1);
    // The retry produced no second charge, so no second webhook either.
    await new Promise((r) => { setTimeout(r, 150); });
    expect(forCharge(first.body.charge_id)).toHaveLength(1);
  });
});

describe('chaos', () => {
  it('transient failure answers 500 but the charge exists and still calls back', async () => {
    received = [];
    const { status } = await charge('booking-3', 'key-3', 'transient');
    expect(status).toBe(500);

    // The caller has no charge id. This is the unmatched-webhook case: the
    // callback names a charge the API never recorded.
    await waitFor(() => received.some((d) => d.body.reference === 'booking-3'));

    const retry = await charge('booking-3', 'key-3');
    expect(retry.status).toBe(202);
    expect(retry.body.charge_id).toBe(
      received.find((d) => d.body.reference === 'booking-3')!.body.charge_id,
    );
  });

  it('duplicate delivery sends the same event twice with different delivery ids', async () => {
    received = [];
    const { body } = await charge('booking-4', 'key-4', 'duplicate');

    await waitFor(() => forCharge(body.charge_id).length === 2);

    const [one, two] = forCharge(body.charge_id);
    expect(one!.deliveryId).not.toBe(two!.deliveryId);
    expect(one!.raw).toBe(two!.raw);
    expect(one!.body.event).toBe('charge.succeeded');
  });

  it('a forged signature is distinguishable from a genuine one', async () => {
    received = [];
    const { body } = await charge('booking-5', 'key-5', 'bad-signature');

    await waitFor(() => forCharge(body.charge_id).length === 1);

    const [delivery] = forCharge(body.charge_id);
    expect(signatureMatches(delivery!.raw, SECRET, delivery!.signature)).toBe(false);
    // The payload itself is untouched — only the signature is wrong, so a
    // handler that parses before verifying would process it happily.
    expect(delivery!.body.event).toBe('charge.succeeded');
  });

  it('a declined charge reports charge.failed', async () => {
    received = [];
    const { body } = await charge('booking-6', 'key-6', 'declined');

    await waitFor(() => forCharge(body.charge_id).length === 1);
    expect(forCharge(body.charge_id)[0]!.body.event).toBe('charge.failed');
  });

  it('the race delivers the webhook before the 202 is answered', async () => {
    received = [];
    const inFlight = charge('booking-7', 'key-7', 'race');

    // The callback lands while the caller is still waiting for its charge id.
    await waitFor(() => received.some((d) => d.body.reference === 'booking-7'));
    const arrivedFirst = received.some((d) => d.body.reference === 'booking-7');

    const { status } = await inFlight;
    expect(arrivedFirst).toBe(true);
    expect(status).toBe(202);
  });
});

describe('refunds', () => {
  it('accepts a refund and calls back with refund.succeeded', async () => {
    received = [];
    const { body } = await charge('booking-8', 'key-8');
    await waitFor(() => forCharge(body.charge_id).length === 1);

    const res = await fetch(`${paygateUrl}/paygate/refunds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'refund-key-1' },
      body: JSON.stringify({ charge_id: body.charge_id, amount_minor: 22_500 }),
    });
    expect(res.status).toBe(202);
    const refund = await res.json() as Record<string, string>;
    expect(refund.refund_id).toMatch(/^rf_/);

    await waitFor(() => received.some((d) => d.body.event === 'refund.succeeded'));
    const delivery = received.find((d) => d.body.event === 'refund.succeeded')!;
    expect(delivery.body.refund_id).toBe(refund.refund_id);
    expect(delivery.body.amount_minor).toBe(22_500);
    expect(signatureMatches(delivery.raw, SECRET, delivery.signature)).toBe(true);
  });

  it('a refund retried with the same key does not refund twice', async () => {
    received = [];
    const { body } = await charge('booking-9', 'key-9');

    const post = () => fetch(`${paygateUrl}/paygate/refunds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'refund-key-2' },
      body: JSON.stringify({ charge_id: body.charge_id, amount_minor: 1_000 }),
    }).then((r) => r.json() as Promise<Record<string, string>>);

    const first = await post();
    const second = await post();
    expect(second.refund_id).toBe(first.refund_id);

    await waitFor(() => received.some((d) => d.body.event === 'refund.succeeded'));
    await new Promise((r) => { setTimeout(r, 150); });
    expect(received.filter((d) => d.body.event === 'refund.succeeded')).toHaveLength(1);
  });

  it('a refund against an unknown charge is 404, not 500', async () => {
    const res = await fetch(`${paygateUrl}/paygate/refunds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'refund-key-3' },
      body: JSON.stringify({ charge_id: 'ch_nope', amount_minor: 100 }),
    });
    expect(res.status).toBe(404);
  });
});

describe('signing', () => {
  it('verification is over the raw body, and rejects a re-serialised one', () => {
    const raw = '{"charge_id":"ch_1","event":"charge.succeeded"}';
    const signature = sign(raw, SECRET);

    expect(signatureMatches(raw, SECRET, signature)).toBe(true);
    // Same object, different byte order. A handler that parses first would
    // compute a different digest and reject a genuine delivery.
    expect(signatureMatches(
      '{"event":"charge.succeeded","charge_id":"ch_1"}', SECRET, signature,
    )).toBe(false);
    expect(signatureMatches(raw, 'wrong-secret', signature)).toBe(false);
  });
});

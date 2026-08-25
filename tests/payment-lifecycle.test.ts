/**
 * One booking end to end: hold, pay, charge, callback, CONFIRMED.
 *
 * Both servers listen on real ports and Paygate signs a real HMAC, so this
 * proves what a unit test cannot — the signature the provider computes is the
 * one the handler accepts, over the same bytes.
 *
 * Chaos is off. M3 turns it on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { build } from '../src/server.js';
import { buildPaygate } from '../src/paygate/server.js';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { processWebhooks, submitPendingCharges } from '../src/worker/jobs.js';

let app: FastifyInstance;
let paygate: FastifyInstance;
let token: string;
let roomId: string;
let apiUrl: string;

const OPEN_ALL_DAY = {
  mon: [['00:00', '23:59']], tue: [['00:00', '23:59']], wed: [['00:00', '23:59']],
  thu: [['00:00', '23:59']], fri: [['00:00', '23:59']], sat: [['00:00', '23:59']],
  sun: [['00:00', '23:59']],
};

beforeAll(async () => {
  app = await build();
  await app.listen({ port: 0, host: '127.0.0.1' });
  apiUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

  // Paygate on the port config already points at, so nothing has to be
  // restubbed. The compose service does not publish 4000 to the host.
  paygate = buildPaygate({
    secret: config.paygateSecret,
    callbackUrl: `${apiUrl}/webhooks/paygate`,
    chaos: false,
    seed: 7,
    timeScale: 0.001,
  });
  await paygate.listen({ port: 4000, host: '127.0.0.1' });

  // Its own venue and room. Sharing the seeded calendar would make the test
  // depend on which slots happen to be free.
  const { rows: [venue] } = await pool.query<{ id: string }>(
    `INSERT INTO venues (name, city, timezone, operating_hours, current_policy_version_id)
     VALUES ($1, 'Karachi', 'Asia/Karachi', $2,
             (SELECT id FROM refund_policy_versions
              WHERE venue_id IS NULL ORDER BY created_at DESC LIMIT 1))
     RETURNING id`,
    [`Payment fixture ${Date.now()}`, JSON.stringify(OPEN_ALL_DAY)],
  );
  const { rows: [room] } = await pool.query<{ id: string }>(
    `INSERT INTO rooms (venue_id, name, capacity, hourly_rate_minor, amenities, city)
     VALUES ($1, 'Fixture Studio', 10, 500000, '{}', 'Karachi') RETURNING id`,
    [venue!.id],
  );
  roomId = room!.id;

  const login = await api('POST', '/auth/login', {
    email: 'customer@atrium.test', password: 'atrium123',
  });
  token = login.body.token as string;
});

afterAll(async () => {
  await paygate.close();
  await app.close();
  await pool.end();
});

async function api(
  method: string, path: string, body?: unknown, auth = false,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(apiUrl + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(auth ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

/** A half-hour aligned slot far enough out that nothing else holds it. */
let slotCursor = 20;
function nextSlot(): { startAt: string; endAt: string } {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const start = new Date(midnight.getTime() + (slotCursor++) * 86_400_000 + 6 * 3_600_000);
  return {
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 3_600_000).toISOString(),
  };
}

async function hold(): Promise<string> {
  const res = await api('POST', '/bookings/hold', { roomId, ...nextSlot() }, true);
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const statusOf = async (id: string): Promise<string> => (await pool.query<{ status: string }>(
  'SELECT status FROM bookings WHERE id = $1', [id],
)).rows[0]!.status;

/** The delivery is asynchronous; this waits for the row rather than sleeping blind. */
async function waitForWebhook(chargeId: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query(
      'SELECT 1 FROM webhook_events WHERE charge_id = $1', [chargeId],
    );
    if (rows.length > 0) return;
    await new Promise((r) => { setTimeout(r, 25); });
  }
  throw new Error(`no webhook recorded for ${chargeId}`);
}

async function chargeIdOf(paymentId: string): Promise<string> {
  const { rows } = await pool.query<{ charge_id: string | null }>(
    'SELECT charge_id FROM payments WHERE id = $1', [paymentId],
  );
  const chargeId = rows[0]?.charge_id;
  if (!chargeId) throw new Error('payment was never submitted');
  return chargeId;
}

describe('the full lifecycle', () => {
  it('takes a hold from HELD to CONFIRMED through the provider', async () => {
    const bookingId = await hold();
    expect(await statusOf(bookingId)).toBe('HELD');

    const pay = await api('POST', `/bookings/${bookingId}/pay`, undefined, true);
    expect(pay.status).toBe(202);
    expect(pay.body.status).toBe('PENDING');
    expect(pay.body.chargeId).toBeNull();
    expect(await statusOf(bookingId)).toBe('PENDING_PAYMENT');

    await submitPendingCharges();
    const chargeId = await chargeIdOf(pay.body.paymentId as string);
    expect(chargeId).toMatch(/^ch_/);

    await waitForWebhook(chargeId);
    await processWebhooks();

    expect(await statusOf(bookingId)).toBe('CONFIRMED');

    const { rows: [payment] } = await pool.query<{ status: string }>(
      'SELECT status FROM payments WHERE id = $1', [pay.body.paymentId],
    );
    expect(payment!.status).toBe('CAPTURED');
  });

  it('writes one audit row per transition, and no more', async () => {
    const bookingId = await hold();
    const pay = await api('POST', `/bookings/${bookingId}/pay`, undefined, true);
    await submitPendingCharges();
    await waitForWebhook(await chargeIdOf(pay.body.paymentId as string));
    await processWebhooks();

    const { rows } = await pool.query<{ from_state: string | null; to_state: string }>(
      `SELECT from_state, to_state FROM audit_events
       WHERE booking_id = $1 ORDER BY occurred_at, id`,
      [bookingId],
    );
    expect(rows.map((r) => `${r.from_state ?? '-'}>${r.to_state}`)).toEqual([
      '->HELD', 'HELD>PENDING_PAYMENT', 'PENDING_PAYMENT>CONFIRMED',
    ]);
  });
});

describe('INV-3, a booking is charged at most once', () => {
  it('a second pay returns the first charge rather than creating another', async () => {
    const bookingId = await hold();

    const first = await api('POST', `/bookings/${bookingId}/pay`, undefined, true);
    const second = await api('POST', `/bookings/${bookingId}/pay`, undefined, true);

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.body.paymentId).toBe(first.body.paymentId);

    const { rows } = await pool.query(
      'SELECT id FROM payments WHERE booking_id = $1', [bookingId],
    );
    expect(rows).toHaveLength(1);
  });

  it('a redelivered webhook changes nothing the second time', async () => {
    const bookingId = await hold();
    const pay = await api('POST', `/bookings/${bookingId}/pay`, undefined, true);
    await submitPendingCharges();
    const chargeId = await chargeIdOf(pay.body.paymentId as string);
    await waitForWebhook(chargeId);
    await processWebhooks();

    expect(await statusOf(bookingId)).toBe('CONFIRMED');
    const auditBefore = await auditCount(bookingId);

    // The provider redelivers the same business event under a new delivery id.
    // Deduplication is on (charge_id, event_type), so intake refuses it before
    // the worker ever sees it a second time.
    const replay = await deliver(chargeId, bookingId);
    expect(replay.status).toBe(200);
    expect(replay.body.duplicate).toBe(true);

    await processWebhooks();
    expect(await statusOf(bookingId)).toBe('CONFIRMED');
    expect(await auditCount(bookingId)).toBe(auditBefore);
  });
});

describe('webhook intake', () => {
  it('refuses a forged signature with 401 and records nothing', async () => {
    const before = await eventCount();
    const res = await fetch(`${apiUrl}/webhooks/paygate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-paygate-signature': 'not-a-signature' },
      body: JSON.stringify({ charge_id: 'ch_forged', event: 'charge.succeeded' }),
    });
    expect(res.status).toBe(401);
    expect(await eventCount()).toBe(before);
  });

  it('refuses a delivery with no signature at all', async () => {
    const res = await fetch(`${apiUrl}/webhooks/paygate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ charge_id: 'ch_unsigned', event: 'charge.succeeded' }),
    });
    expect(res.status).toBe(401);
  });

  it('accepts a charge it has never heard of, and parks it', async () => {
    // 25% of callbacks beat the 202 that would have told us the charge id, so
    // an unknown charge is expected. It must not 500 and must not vanish.
    const res = await deliver('ch_never_submitted', 'booking-that-does-not-exist');
    expect(res.status).toBe(200);

    await processWebhooks();

    const { rows } = await pool.query(
      'SELECT 1 FROM unmatched_webhooks WHERE charge_id = $1', ['ch_never_submitted'],
    );
    expect(rows).toHaveLength(1);
  });
});

/** Signs and posts a delivery the way Paygate would. */
async function deliver(
  chargeId: string, reference: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { sign } = await import('../src/paygate/server.js');
  const raw = JSON.stringify({
    charge_id: chargeId,
    reference,
    event: 'charge.succeeded',
    amount_minor: 500_000,
    occurred_at: new Date().toISOString(),
  });
  const res = await fetch(`${apiUrl}/webhooks/paygate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-paygate-signature': sign(raw, config.paygateSecret),
      'x-paygate-delivery': crypto.randomUUID(),
    },
    body: raw,
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const auditCount = async (bookingId: string): Promise<number> => Number(
  (await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM audit_events WHERE booking_id = $1', [bookingId],
  )).rows[0]!.n,
);

const eventCount = async (): Promise<number> => Number(
  (await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM webhook_events')).rows[0]!.n,
);

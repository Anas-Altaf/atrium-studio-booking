/**
 * The provider misbehaving, one behaviour at a time.
 *
 * Every case is forced with `X-Paygate-Force` rather than waited for, so a
 * failure names the behaviour that broke it. The soak script covers the other
 * half of the question — whether they hold together under real chaos.
 *
 * INV-4 is the one the brief says it will test directly: a capture landing on a
 * hold that has already expired must refund, never confirm.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { build } from '../src/server.js';
import { buildPaygate, sign } from '../src/paygate/server.js';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { driveRefunds, processWebhooks, reapHolds, submitPendingCharges } from '../src/worker/jobs.js';

let app: FastifyInstance;
let paygate: FastifyInstance;
let apiUrl: string;
let token: string;
let roomId: string;
let slotOffset = 300;

const OPEN_ALL_DAY = {
  mon: [['00:00', '23:59']], tue: [['00:00', '23:59']], wed: [['00:00', '23:59']],
  thu: [['00:00', '23:59']], fri: [['00:00', '23:59']], sat: [['00:00', '23:59']],
  sun: [['00:00', '23:59']],
};

beforeAll(async () => {
  app = await build();
  await app.listen({ port: 0, host: '127.0.0.1' });
  apiUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

  paygate = buildPaygate({
    secret: config.paygateSecret,
    callbackUrl: `${apiUrl}/webhooks/paygate`,
    chaos: false,
    seed: 21,
    timeScale: 0.001,
  });
  await paygate.listen({ port: 4000, host: '127.0.0.1' });

  const { rows: [venue] } = await pool.query<{ id: string }>(
    `INSERT INTO venues (name, city, timezone, operating_hours, current_policy_version_id)
     VALUES ($1, 'Karachi', 'Asia/Karachi', $2,
             (SELECT id FROM refund_policy_versions
              WHERE venue_id IS NULL ORDER BY created_at DESC LIMIT 1))
     RETURNING id`,
    [`Chaos fixture ${Date.now()}`, JSON.stringify(OPEN_ALL_DAY)],
  );
  const { rows: [room] } = await pool.query<{ id: string }>(
    `INSERT INTO rooms (venue_id, name, capacity, hourly_rate_minor, amenities, city)
     VALUES ($1, 'Chaos Studio', 10, 500000, '{}', 'Karachi') RETURNING id`,
    [venue!.id],
  );
  roomId = room!.id;

  const res = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'customer@atrium.test', password: 'atrium123' }),
  });
  token = ((await res.json()) as { token: string }).token;
});

afterAll(async () => {
  await paygate.close();
  await app.close();
  await pool.end();
});

async function hold(): Promise<string> {
  // Two hours apart, not one: reserved_range carries the 15 minute turnaround,
  // so consecutive one-hour bookings an hour apart overlap each other.
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const start = new Date(midnight.getTime() + slotOffset * 3_600_000);
  slotOffset += 2;

  const res = await fetch(`${apiUrl}/bookings/hold`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      roomId,
      startAt: start.toISOString(),
      endAt: new Date(start.getTime() + 3_600_000).toISOString(),
      equipment: [],
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function pay(bookingId: string): Promise<string> {
  const res = await fetch(`${apiUrl}/bookings/${bookingId}/pay`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` },
  });
  return ((await res.json()) as { paymentId: string }).paymentId;
}

/**
 * Submits with the given chaos behaviour forced on the provider.
 *
 * One attempt, not a batch. The worker retries a failed submission within the
 * same call, and the provider's idempotent replay answers 202 with the original
 * charge — correct behaviour, but it hides the failure the test is about.
 */
async function submitWithChaos(force: string, attempts = 1): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (String(input).includes('/paygate/')) headers.set('x-paygate-force', force);
    return original(input, { ...init, headers });
  }) as typeof fetch;

  try {
    await submitPendingCharges(undefined, attempts);
  } finally {
    globalThis.fetch = original;
  }
}

const statusOf = async (id: string): Promise<string> => (await pool.query<{ status: string }>(
  'SELECT status FROM bookings WHERE id = $1', [id],
)).rows[0]!.status;

const chargeIdOf = async (paymentId: string): Promise<string | null> => (
  await pool.query<{ charge_id: string | null }>(
    'SELECT charge_id FROM payments WHERE id = $1', [paymentId],
  )).rows[0]!.charge_id;

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => { setTimeout(r, 25); });
  }
  throw new Error('timed out');
}

/**
 * `driveRefunds` claims the oldest due refunds first, a batch at a time, and it
 * has no idea which one this test is waiting on. Earlier files and earlier runs
 * leave PENDING refunds behind, so a single call can spend its whole batch on
 * rows that are not ours and this test times out having proved nothing.
 *
 * Drive until this booking's own refund reaches the provider.
 */
async function driveUntilSubmitted(bookingId: string): Promise<void> {
  await waitFor(async () => {
    await driveRefunds();
    const { rows } = await pool.query<{ provider_refund_id: string | null }>(
      'SELECT provider_refund_id FROM refunds WHERE booking_id = $1', [bookingId],
    );
    return Boolean(rows[0]?.provider_refund_id);
  }, 10_000);
}

const eventCount = async (chargeId: string): Promise<number> => Number(
  (await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM webhook_events WHERE charge_id = $1', [chargeId],
  )).rows[0]!.n,
);

describe('INV-4 — a capture on an expired hold refunds, never confirms', () => {
  it('routes the money back and leaves the booking EXPIRED', async () => {
    const bookingId = await hold();
    const paymentId = await pay(bookingId);
    await submitPendingCharges();
    const chargeId = (await chargeIdOf(paymentId))!;

    // The hold runs out while the charge is in flight.
    await pool.query(
      `UPDATE bookings SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [bookingId],
    );
    await reapHolds();
    expect(await statusOf(bookingId)).toBe('EXPIRED');

    await waitFor(async () => (await eventCount(chargeId)) > 0);
    await processWebhooks();

    // Not confirmed. The capture is recorded, and the money is owed back.
    expect(await statusOf(bookingId)).toBe('EXPIRED');

    const { rows: [payment] } = await pool.query<{ status: string }>(
      'SELECT status FROM payments WHERE id = $1', [paymentId],
    );
    expect(payment!.status).toBe('CAPTURED');

    const { rows: [refund] } = await pool.query<{ amount_minor: number; status: string }>(
      'SELECT amount_minor, status FROM refunds WHERE booking_id = $1', [bookingId],
    );
    expect(refund!.status).toBe('PENDING');
    expect(refund!.amount_minor).toBe(500_000);
  });

  it('drives the refund to the provider and reaches REFUNDED', async () => {
    const bookingId = await hold();
    const paymentId = await pay(bookingId);
    await submitPendingCharges();
    const chargeId = (await chargeIdOf(paymentId))!;

    await pool.query(
      `UPDATE bookings SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [bookingId],
    );
    await reapHolds();
    await waitFor(async () => (await eventCount(chargeId)) > 0);
    await processWebhooks();

    await driveUntilSubmitted(bookingId);
    await waitFor(async () => Number(
      (await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM webhook_events
         WHERE charge_id = $1 AND event_type = 'refund.succeeded'`, [chargeId],
      )).rows[0]!.n,
    ) > 0);
    await processWebhooks();

    expect(await statusOf(bookingId)).toBe('REFUNDED');

    const { rows: [refund] } = await pool.query<{ status: string; provider_refund_id: string }>(
      'SELECT status, provider_refund_id FROM refunds WHERE booking_id = $1', [bookingId],
    );
    expect(refund!.status).toBe('SUCCEEDED');
    expect(refund!.provider_refund_id).toMatch(/^rf_/);
  });

  it('writes the whole sequence to the audit trail', async () => {
    const bookingId = await hold();
    const paymentId = await pay(bookingId);
    await submitPendingCharges();
    const chargeId = (await chargeIdOf(paymentId))!;

    await pool.query(
      `UPDATE bookings SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [bookingId],
    );
    await reapHolds();
    await waitFor(async () => (await eventCount(chargeId)) > 0);
    await processWebhooks();
    await driveUntilSubmitted(bookingId);
    await waitFor(async () => Number(
      (await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM webhook_events
         WHERE charge_id = $1 AND event_type = 'refund.succeeded'`, [chargeId],
      )).rows[0]!.n,
    ) > 0);
    await processWebhooks();

    const { rows } = await pool.query<{ from_state: string | null; to_state: string }>(
      `SELECT from_state, to_state FROM audit_events
       WHERE booking_id = $1 ORDER BY occurred_at, id`,
      [bookingId],
    );
    expect(rows.map((r) => `${r.from_state ?? '-'}>${r.to_state}`)).toEqual([
      '->HELD', 'HELD>PENDING_PAYMENT', 'PENDING_PAYMENT>EXPIRED', 'EXPIRED>REFUNDED',
    ]);
  });
});

describe('chaos behaviours, one at a time', () => {
  it('a transient 500 leaves no charge id, and the retry does not double charge', async () => {
    const bookingId = await hold();
    const paymentId = await pay(bookingId);

    await submitWithChaos('transient');
    expect(await chargeIdOf(paymentId)).toBeNull();

    // The provider took the request despite the 500, so its callback names a
    // charge this API has never recorded.
    await submitPendingCharges();
    const chargeId = await chargeIdOf(paymentId);
    expect(chargeId).toMatch(/^ch_/);

    const { rows } = await pool.query(
      'SELECT id FROM payments WHERE booking_id = $1', [bookingId],
    );
    expect(rows).toHaveLength(1);
  });

  it('a duplicate delivery is recorded once and applied once', async () => {
    const bookingId = await hold();
    const paymentId = await pay(bookingId);
    await submitWithChaos('duplicate');
    const chargeId = (await chargeIdOf(paymentId))!;

    await waitFor(async () => (await eventCount(chargeId)) > 0);
    await new Promise((r) => { setTimeout(r, 200); });

    // Two deliveries, one row: dedup is on (charge_id, event_type).
    expect(await eventCount(chargeId)).toBe(1);

    await processWebhooks();
    expect(await statusOf(bookingId)).toBe('CONFIRMED');

    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events
       WHERE booking_id = $1 AND to_state = 'CONFIRMED'`, [bookingId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('a forged signature is refused and never recorded', async () => {
    const raw = JSON.stringify({
      charge_id: 'ch_forged_by_chaos', reference: 'x',
      event: 'charge.succeeded', amount_minor: 1,
    });
    const res = await fetch(`${apiUrl}/webhooks/paygate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-paygate-signature': sign(raw, 'the-wrong-secret'),
      },
      body: raw,
    });

    expect(res.status).toBe(401);
    expect(await eventCount('ch_forged_by_chaos')).toBe(0);
  });

  it('a callback for an unknown charge is parked, not dropped and not a 500', async () => {
    const raw = JSON.stringify({
      charge_id: 'ch_unknown_to_us', reference: 'nothing',
      event: 'charge.succeeded', amount_minor: 1,
    });
    const res = await fetch(`${apiUrl}/webhooks/paygate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-paygate-signature': sign(raw, config.paygateSecret),
      },
      body: raw,
    });
    expect(res.status).toBe(200);

    await processWebhooks();

    const { rows } = await pool.query(
      'SELECT 1 FROM unmatched_webhooks WHERE charge_id = $1', ['ch_unknown_to_us'],
    );
    expect(rows).toHaveLength(1);
  });

  it('a declined charge fails the booking rather than confirming it', async () => {
    const bookingId = await hold();
    const paymentId = await pay(bookingId);
    await submitWithChaos('declined');
    const chargeId = (await chargeIdOf(paymentId))!;

    await waitFor(async () => (await eventCount(chargeId)) > 0);
    await processWebhooks();

    expect(await statusOf(bookingId)).toBe('FAILED');
    const { rows: [payment] } = await pool.query<{ status: string }>(
      'SELECT status FROM payments WHERE id = $1', [paymentId],
    );
    expect(payment!.status).toBe('FAILED');
  });
});

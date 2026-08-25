/**
 * Cancelling a booking, and the policy the refund is read through.
 *
 * The brief's requirement that a policy change must not retroactively alter an
 * already-confirmed booking is the last test in this file, and it is the one
 * worth reading: it changes a venue's terms and then cancels a booking made
 * under the old ones.
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
let apiUrl: string;
let customerToken: string;
let adminToken: string;
let venueId: string;
let roomId: string;
let slotOffset = 600;

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
    seed: 33,
    timeScale: 0.001,
  });
  await paygate.listen({ port: 4000, host: '127.0.0.1' });

  const { rows: [venue] } = await pool.query<{ id: string }>(
    `INSERT INTO venues (name, city, timezone, operating_hours, current_policy_version_id)
     VALUES ($1, 'Karachi', 'Asia/Karachi', $2,
             (SELECT id FROM refund_policy_versions
              WHERE venue_id IS NULL ORDER BY created_at DESC LIMIT 1))
     RETURNING id`,
    [`Cancel fixture ${Date.now()}`, JSON.stringify(OPEN_ALL_DAY)],
  );
  venueId = venue!.id;

  const { rows: [room] } = await pool.query<{ id: string }>(
    `INSERT INTO rooms (venue_id, name, capacity, hourly_rate_minor, amenities, city)
     VALUES ($1, 'Cancel Studio', 10, 400000, '{}', 'Karachi') RETURNING id`,
    [venueId],
  );
  roomId = room!.id;

  // The venue's own admin, so the policy endpoint has a caller who owns it.
  await pool.query(
    `INSERT INTO users (email, password_hash, role, venue_id)
     VALUES ($1, (SELECT password_hash FROM users WHERE email = 'admin.a@atrium.test'),
             'VENUE_ADMIN', $2)`,
    [`cancel-admin-${Date.now()}@atrium.test`, venueId],
  );
  const { rows: [admin] } = await pool.query<{ email: string }>(
    `SELECT email FROM users WHERE venue_id = $1 AND role = 'VENUE_ADMIN' LIMIT 1`,
    [venueId],
  );

  customerToken = await login('customer@atrium.test');
  adminToken = await login(admin!.email);
});

afterAll(async () => {
  await paygate.close();
  await app.close();
  await pool.end();
});

async function login(email: string): Promise<string> {
  const res = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'atrium123' }),
  });
  return ((await res.json()) as { token: string }).token;
}

async function call(
  method: string, path: string, body: unknown, token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(apiUrl + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** `startsInHours` decides which refund band applies. */
async function hold(startsInHours: number): Promise<string> {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const start = new Date(midnight.getTime() + slotOffset * 3_600_000);
  slotOffset += 2;

  // The hold path enforces the 90 day horizon, so the booking is placed
  // normally and its start moved afterwards to reach the band under test.
  const res = await call('POST', '/bookings/hold', {
    roomId,
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 3_600_000).toISOString(),
    equipment: [],
  }, customerToken);
  expect(res.status).toBe(201);

  const id = res.body.id as string;
  // From an hour boundary, so half_hour_granularity holds. That puts the start
  // between N-1 and N hours away, which stays inside the band under test.
  await pool.query(
    `UPDATE bookings
     SET start_at = date_trunc('hour', now()) + ($2 || ' hours')::interval,
         end_at   = date_trunc('hour', now()) + (($2::numeric + 1) || ' hours')::interval
     WHERE id = $1`,
    [id, String(startsInHours)],
  );
  return id;
}

/** Takes a booking all the way to CONFIRMED so there is money to return. */
async function confirmed(startsInHours: number): Promise<string> {
  const id = await hold(startsInHours);
  await call('POST', `/bookings/${id}/pay`, null, customerToken);
  await submitPendingCharges();

  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    await processWebhooks();
    if (await statusOf(id) === 'CONFIRMED') return id;
    await new Promise((r) => { setTimeout(r, 25); });
  }
  throw new Error('booking never confirmed');
}

const statusOf = async (id: string): Promise<string> => (await pool.query<{ status: string }>(
  'SELECT status FROM bookings WHERE id = $1', [id],
)).rows[0]!.status;

const refundOf = async (id: string) => (await pool.query<{
  amount_minor: number; status: string; reason: string;
}>('SELECT amount_minor, status, reason FROM refunds WHERE booking_id = $1', [id])).rows[0];

describe('cancelling a hold', () => {
  it('releases the slot and takes no money', async () => {
    const id = await hold(72);

    const res = await call('POST', `/bookings/${id}/cancel`, null, customerToken);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.refund).toBeNull();
    expect(await refundOf(id)).toBeUndefined();
  });
});

describe('cancelling a confirmed booking', () => {
  it('returns everything more than 48 hours out', async () => {
    const id = await confirmed(72);

    const res = await call('POST', `/bookings/${id}/cancel`, null, customerToken);
    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe('CANCELLED');
    expect((res.body.refund as { amountMinor: number }).amountMinor).toBe(400_000);
  });

  it('halves the room charge between 24 and 48 hours', async () => {
    const id = await confirmed(36);

    await call('POST', `/bookings/${id}/cancel`, null, customerToken);
    expect((await refundOf(id))!.amount_minor).toBe(200_000);
  });

  it('returns nothing inside two hours, and writes no refund row', async () => {
    const id = await confirmed(1);

    const res = await call('POST', `/bookings/${id}/cancel`, null, customerToken);
    expect(res.body.refund).toBeNull();
    expect(await refundOf(id)).toBeUndefined();
    expect(await statusOf(id)).toBe('CANCELLED');
  });
});

describe('a repeat cancel is a replay', () => {
  it('answers 200 with the same refund, and creates only one', async () => {
    const id = await confirmed(72);

    const first = await call('POST', `/bookings/${id}/cancel`, null, customerToken);
    const second = await call('POST', `/bookings/${id}/cancel`, null, customerToken);

    expect(second.status).toBe(200);
    expect(second.body.cancelled).toBe(false);
    expect((second.body.refund as { id: string }).id)
      .toBe((first.body.refund as { id: string }).id);

    const { rows } = await pool.query('SELECT id FROM refunds WHERE booking_id = $1', [id]);
    expect(rows).toHaveLength(1);
  });

  it('writes one CANCELLED audit event, not two', async () => {
    const id = await confirmed(72);
    await call('POST', `/bookings/${id}/cancel`, null, customerToken);
    await call('POST', `/bookings/${id}/cancel`, null, customerToken);

    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events
       WHERE booking_id = $1 AND to_state = 'CANCELLED'`, [id],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });
});

describe('policy is data', () => {
  it('a venue admin publishes new tiers through the API', async () => {
    const res = await call('PATCH', `/venues/${venueId}/policy`, {
      tiers: [
        { hours_before: 24, room_pct: 100, equipment_pct: 100 },
        { hours_before: 0, room_pct: 0, equipment_pct: 0 },
      ],
    }, adminToken);

    expect(res.status).toBe(200);
    expect(res.body.policyVersionId).toBeTruthy();

    const { rows } = await pool.query<{ id: string }>(
      'SELECT current_policy_version_id AS id FROM venues WHERE id = $1', [venueId],
    );
    expect(rows[0]!.id).toBe(res.body.policyVersionId);
  });

  it('refuses an admin from another venue', async () => {
    const res = await call('PATCH', `/venues/${venueId}/policy`, {
      tiers: [{ hours_before: 0, room_pct: 100, equipment_pct: 100 }],
    }, await login('admin.b@atrium.test'));

    expect(res.status).toBe(403);
  });

  it('refuses tiers with no band covering the final hours', async () => {
    const res = await call('PATCH', `/venues/${venueId}/policy`, {
      tiers: [{ hours_before: 48, room_pct: 100, equipment_pct: 100 }],
    }, adminToken);

    expect(res.status).toBe(400);
  });

  /**
   * The requirement in section 07: a policy change must not alter the terms of
   * a booking already made. The booking below is confirmed under tiers that
   * refund half at 36 hours; the venue then publishes tiers that refund
   * nothing, and the booking still refunds half.
   */
  it('does not reach a booking already confirmed', async () => {
    // The terms in force when the booking is made: half the room at 24-48h.
    await call('PATCH', `/venues/${venueId}/policy`, {
      tiers: [
        { hours_before: 48, room_pct: 100, equipment_pct: 100 },
        { hours_before: 24, room_pct: 50, equipment_pct: 100 },
        { hours_before: 0, room_pct: 0, equipment_pct: 0 },
      ],
    }, adminToken);

    const id = await confirmed(36);

    // The venue changes its mind afterwards, to refunding nothing.
    await call('PATCH', `/venues/${venueId}/policy`, {
      tiers: [{ hours_before: 0, room_pct: 0, equipment_pct: 0 }],
    }, adminToken);

    await call('POST', `/bookings/${id}/cancel`, null, customerToken);

    // Still the old terms: half the room.
    expect((await refundOf(id))!.amount_minor).toBe(200_000);
  });

  it('applies to a booking made after it', async () => {
    await call('PATCH', `/venues/${venueId}/policy`, {
      tiers: [{ hours_before: 0, room_pct: 0, equipment_pct: 0 }],
    }, adminToken);

    const id = await confirmed(72);
    await call('POST', `/bookings/${id}/cancel`, null, customerToken);

    expect(await refundOf(id)).toBeUndefined();
  });
});

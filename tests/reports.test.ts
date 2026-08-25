/**
 * INV-5 and the availability read.
 *
 * The reconciliation endpoint is the one the invariant's own wording asks for:
 * something that returns zero discrepancies on demand. These tests plant each
 * discrepancy it looks for, so a zero means the queries work rather than that
 * the database happens to be tidy.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { build } from '../src/server.js';
import { pool } from '../src/db/pool.js';

let app: FastifyInstance;
let apiUrl: string;
let platformToken: string;
let customerToken: string;
let venueId: string;
let roomId: string;
let userId: string;
let policyId: string;
let slotOffset = 800;

const OPEN_ALL_DAY = {
  mon: [['00:00', '23:59']], tue: [['00:00', '23:59']], wed: [['00:00', '23:59']],
  thu: [['00:00', '23:59']], fri: [['00:00', '23:59']], sat: [['00:00', '23:59']],
  sun: [['00:00', '23:59']],
};

beforeAll(async () => {
  app = await build();
  await app.listen({ port: 0, host: '127.0.0.1' });
  apiUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

  const { rows: [venue] } = await pool.query<{ id: string; policy: string }>(
    `INSERT INTO venues (name, city, timezone, operating_hours, current_policy_version_id)
     VALUES ($1, 'Karachi', 'Asia/Karachi', $2,
             (SELECT id FROM refund_policy_versions
              WHERE venue_id IS NULL ORDER BY created_at DESC LIMIT 1))
     RETURNING id, current_policy_version_id AS policy`,
    [`Report fixture ${Date.now()}`, JSON.stringify(OPEN_ALL_DAY)],
  );
  venueId = venue!.id;
  policyId = venue!.policy;

  const { rows: [room] } = await pool.query<{ id: string }>(
    `INSERT INTO rooms (venue_id, name, capacity, hourly_rate_minor, amenities, city)
     VALUES ($1, 'Report Studio', 10, 300000, '{}', 'Karachi') RETURNING id`,
    [venueId],
  );
  roomId = room!.id;

  const { rows: [user] } = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE email = 'customer@atrium.test'`,
  );
  userId = user!.id;

  platformToken = await login('platform@atrium.test');
  customerToken = await login('customer@atrium.test');
});

afterAll(async () => {
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

async function get(path: string, token: string) {
  const res = await fetch(apiUrl + path, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

async function booking(status: string): Promise<string> {
  const start = slotOffset;
  slotOffset += 2;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO bookings
       (venue_id, room_id, user_id, status, start_at, end_at,
        expires_at, policy_version_id, total_minor)
     VALUES ($1, $2, $3, $4::booking_status,
             date_trunc('hour', now()) + ($5 || ' hours')::interval,
             date_trunc('hour', now()) + ($6 || ' hours')::interval,
             CASE WHEN $4 = 'HELD' THEN now() + interval '8 minutes' END,
             $7, 300000)
     RETURNING id`,
    [venueId, roomId, userId, status, String(start), String(start + 1), policyId],
  );
  return rows[0]!.id;
}

async function payment(bookingId: string, status: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO payments (booking_id, idempotency_key, amount_minor, status, charge_id)
     VALUES ($1, gen_random_uuid(), 300000, $2::payment_status, $3)
     RETURNING id`,
    [bookingId, status, `ch_report_${Date.now()}_${Math.floor(Math.random() * 1e6)}`],
  );
  return rows[0]!.id;
}

const kinds = (body: Record<string, unknown>) =>
  (body.discrepancies as { kind: string }[]).map((d) => d.kind);

describe('reconciliation', () => {
  it('is refused to a customer', async () => {
    const res = await get('/reports/reconciliation', customerToken);
    expect(res.status).toBe(403);
  });

  it('reports a captured charge whose booking is neither confirmed nor refunded', async () => {
    const id = await booking('CANCELLED');
    await payment(id, 'CAPTURED');

    const res = await get('/reports/reconciliation', platformToken);
    expect(res.status).toBe(200);
    expect(kinds(res.body)).toContain('CAPTURE_WITHOUT_OUTCOME');
  });

  it('reports a confirmed booking with no captured charge', async () => {
    await booking('CONFIRMED');

    const res = await get('/reports/reconciliation', platformToken);
    expect(kinds(res.body)).toContain('CONFIRMED_WITHOUT_CAPTURE');
  });

  it('reports a refund against a charge that was never captured', async () => {
    const id = await booking('CANCELLED');
    const paymentId = await payment(id, 'FAILED');
    await pool.query(
      `INSERT INTO refunds (booking_id, payment_id, amount_minor, reason, idempotency_key)
       VALUES ($1, $2, 1000, 'planted', gen_random_uuid())`,
      [id, paymentId],
    );

    const res = await get('/reports/reconciliation', platformToken);
    expect(kinds(res.body)).toContain('REFUND_WITHOUT_CAPTURE');
  });

  it('does not report a confirmed booking that was paid for', async () => {
    const id = await booking('CONFIRMED');
    await payment(id, 'CAPTURED');

    const res = await get('/reports/reconciliation', platformToken);
    const ids = (res.body.discrepancies as { id: string }[]).map((d) => d.id);
    expect(ids).not.toContain(id);
  });

  it('does not report a cancelled booking whose money was returned', async () => {
    const id = await booking('CANCELLED');
    const paymentId = await payment(id, 'CAPTURED');
    await pool.query(
      `INSERT INTO refunds (booking_id, payment_id, amount_minor, reason, idempotency_key)
       VALUES ($1, $2, 300000, 'cancelled', gen_random_uuid())`,
      [id, paymentId],
    );

    const res = await get('/reports/reconciliation', platformToken);
    const ids = (res.body.discrepancies as { id: string }[]).map((d) => d.id);
    expect(ids).not.toContain(paymentId);
  });

  it('carries a tally, so the count is read against something', async () => {
    const res = await get('/reports/reconciliation', platformToken);
    const tally = res.body.tally as Record<string, number>;
    expect(tally.captured_minor).toBeGreaterThan(0);
    expect(typeof tally.confirmed_bookings).toBe('number');
  });
});

describe('availability', () => {
  const windowOf = (fromHours: number, days = 7) => {
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    const from = new Date(midnight.getTime() + fromHours * 3_600_000);
    return {
      from: from.toISOString(),
      to: new Date(from.getTime() + days * 86_400_000).toISOString(),
    };
  };

  it('reports what is taken, and the hours the venue is open', async () => {
    const id = await booking('CONFIRMED');
    const { rows: [taken] } = await pool.query<{ start_at: Date }>(
      'SELECT start_at FROM bookings WHERE id = $1', [id],
    );

    const w = windowOf(0, 90);
    const res = await get(
      `/rooms/${roomId}/availability?from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}`,
      customerToken,
    );

    expect(res.status).toBe(200);
    expect(res.body.operatingHours).toBeTruthy();
    const busy = res.body.busy as { startAt: string }[];
    expect(busy.map((b) => new Date(b.startAt).toISOString()))
      .toContain(taken!.start_at.toISOString());
  });

  it('leaves out states that do not block a slot', async () => {
    const id = await booking('CANCELLED');
    const { rows: [taken] } = await pool.query<{ start_at: Date }>(
      'SELECT start_at FROM bookings WHERE id = $1', [id],
    );

    const w = windowOf(0, 90);
    const res = await get(
      `/rooms/${roomId}/availability?from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}`,
      customerToken,
    );

    const busy = res.body.busy as { startAt: string }[];
    expect(busy.map((b) => new Date(b.startAt).toISOString()))
      .not.toContain(taken!.start_at.toISOString());
  });

  it('refuses a window that ends before it starts', async () => {
    const w = windowOf(0, 7);
    const res = await get(
      `/rooms/${roomId}/availability?from=${encodeURIComponent(w.to)}&to=${encodeURIComponent(w.from)}`,
      customerToken,
    );
    expect(res.status).toBe(400);
  });

  it('answers 404 for a room in another venue (INV-6)', async () => {
    const res = await get(
      `/rooms/${roomId}/availability?from=${encodeURIComponent(windowOf(0).from)}`
      + `&to=${encodeURIComponent(windowOf(0).to)}`,
      await login('admin.b@atrium.test'),
    );
    expect(res.status).toBe(404);
  });
});

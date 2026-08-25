/**
 * The checkout window.
 *
 * The brief gives a hold 8 minutes and a customer at checkout at least 10.
 * Those are incompatible until something re-issues the hold, which is what this
 * endpoint does (A1). Without it a customer who takes nine minutes on the
 * payment screen loses a slot the brief says they keep.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { build } from '../src/server.js';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { reapHolds } from '../src/worker/jobs.js';

let app: FastifyInstance;
let apiUrl: string;
let token: string;
let roomId: string;
let slotOffset = 1000;

const OPEN_ALL_DAY = {
  mon: [['00:00', '23:59']], tue: [['00:00', '23:59']], wed: [['00:00', '23:59']],
  thu: [['00:00', '23:59']], fri: [['00:00', '23:59']], sat: [['00:00', '23:59']],
  sun: [['00:00', '23:59']],
};

beforeAll(async () => {
  app = await build();
  await app.listen({ port: 0, host: '127.0.0.1' });
  apiUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

  const { rows: [venue] } = await pool.query<{ id: string }>(
    `INSERT INTO venues (name, city, timezone, operating_hours, current_policy_version_id)
     VALUES ($1, 'Karachi', 'Asia/Karachi', $2,
             (SELECT id FROM refund_policy_versions
              WHERE venue_id IS NULL ORDER BY created_at DESC LIMIT 1))
     RETURNING id`,
    [`Checkout fixture ${Date.now()}`, JSON.stringify(OPEN_ALL_DAY)],
  );
  const { rows: [room] } = await pool.query<{ id: string }>(
    `INSERT INTO rooms (venue_id, name, capacity, hourly_rate_minor, amenities, city)
     VALUES ($1, 'Checkout Studio', 10, 200000, '{}', 'Karachi') RETURNING id`,
    [venue!.id],
  );
  roomId = room!.id;

  token = await login('customer@atrium.test');
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

async function call(method: string, path: string, bearer = token) {
  const res = await fetch(apiUrl + path, {
    method, headers: { authorization: `Bearer ${bearer}` },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

async function hold(): Promise<string> {
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

const expiryOf = async (id: string): Promise<Date> => (await pool.query<{ expires_at: Date }>(
  'SELECT expires_at FROM bookings WHERE id = $1', [id],
)).rows[0]!.expires_at;

describe('reaching checkout', () => {
  it('extends the hold to the window the brief guarantees', async () => {
    const id = await hold();
    const before = await expiryOf(id);

    const res = await call('POST', `/bookings/${id}/checkout`);
    expect(res.status).toBe(200);
    expect(res.body.windowMinutes).toBe(config.checkoutWindowMinutes);

    const after = await expiryOf(id);
    expect(after.getTime()).toBeGreaterThan(before.getTime());

    const minutesLeft = (after.getTime() - Date.now()) / 60_000;
    expect(minutesLeft).toBeGreaterThan(9.5);
    expect(minutesLeft).toBeLessThanOrEqual(10);
  });

  /**
   * The hold TTL is 8 minutes and the checkout window 10, so a booking held for
   * 7 minutes then reaching checkout must come out with 10, not 1.
   */
  it('gives the full window however little was left', async () => {
    const id = await hold();
    await pool.query(
      `UPDATE bookings SET expires_at = now() + interval '1 minute' WHERE id = $1`, [id],
    );

    await call('POST', `/bookings/${id}/checkout`);

    expect((await expiryOf(id)).getTime() - Date.now()).toBeGreaterThan(9.5 * 60_000);
  });

  it('never shortens a hold that already has longer', async () => {
    const id = await hold();
    await pool.query(
      `UPDATE bookings SET expires_at = now() + interval '30 minutes' WHERE id = $1`, [id],
    );

    await call('POST', `/bookings/${id}/checkout`);

    expect((await expiryOf(id)).getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
  });

  it('is audited as HELD to HELD, so a slot held by repeated checkouts is visible', async () => {
    const id = await hold();
    await call('POST', `/bookings/${id}/checkout`);
    await call('POST', `/bookings/${id}/checkout`);

    const { rows } = await pool.query<{ from_state: string; to_state: string; reason: string }>(
      `SELECT from_state, to_state, reason FROM audit_events
       WHERE booking_id = $1 ORDER BY occurred_at, id`,
      [id],
    );
    expect(rows.map((r) => `${r.from_state ?? '-'}>${r.to_state}`))
      .toEqual(['->HELD', 'HELD>HELD', 'HELD>HELD']);
    expect(rows.at(-1)!.reason).toBe('checkout re-issued the hold');
  });

  it('survives the reaper, which is the whole point', async () => {
    const id = await hold();
    // Seven minutes in: the 8 minute TTL is nearly up.
    await pool.query(
      `UPDATE bookings SET expires_at = now() + interval '1 minute' WHERE id = $1`, [id],
    );

    await call('POST', `/bookings/${id}/checkout`);
    await reapHolds();

    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM bookings WHERE id = $1', [id],
    );
    expect(rows[0]!.status).toBe('HELD');
  });
});

describe('checkout refusals', () => {
  it('refuses a hold the reaper already took', async () => {
    const id = await hold();
    await pool.query(
      `UPDATE bookings SET expires_at = now() - interval '1 minute' WHERE id = $1`, [id],
    );

    const res = await call('POST', `/bookings/${id}/checkout`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('HOLD_EXPIRED');
  });

  it('refuses a booking that is no longer held', async () => {
    const id = await hold();
    await call('POST', `/bookings/${id}/cancel`);

    const res = await call('POST', `/bookings/${id}/checkout`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('NOT_HELD');
  });

  it('does not find another customer\'s booking', async () => {
    const id = await hold();
    const res = await call('POST', `/bookings/${id}/checkout`, await login('customer0@atrium.test'));
    expect(res.status).toBe(404);
  });
});

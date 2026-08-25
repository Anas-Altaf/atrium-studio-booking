/**
 * The reads a frontend cannot work without.
 *
 * Before these existed a customer could not list their own bookings, and
 * nothing exposed an equipment type id — so a hold with equipment, which Tier 1
 * requires, was unreachable from any client.
 *
 * Every case here also checks INV-6: scope is what these return, not a filter
 * the caller passes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { build } from '../src/server.js';
import { pool } from '../src/db/pool.js';

let app: FastifyInstance;
let apiUrl: string;
let customer: string;
let adminA: string;
let adminB: string;
let venueId: string;
let roomId: string;
let equipmentId: string;
let slotOffset = 1600;

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
    [`Reads fixture ${Date.now()}`, JSON.stringify(OPEN_ALL_DAY)],
  );
  venueId = venue!.id;

  const { rows: [room] } = await pool.query<{ id: string }>(
    `INSERT INTO rooms (venue_id, name, capacity, hourly_rate_minor, amenities, city)
     VALUES ($1, 'Reads Studio', 12, 180000, '{wifi,piano}', 'Karachi') RETURNING id`,
    [venueId],
  );
  roomId = room!.id;

  const { rows: [equipment] } = await pool.query<{ id: string }>(
    `INSERT INTO equipment_types (venue_id, name, hourly_rate_minor, units_owned)
     VALUES ($1, 'Reads Camera', 25000, 4) RETURNING id`,
    [venueId],
  );
  equipmentId = equipment!.id;

  // An admin who owns this venue, so the isolation cases have both sides.
  const email = `reads-admin-${Date.now()}@atrium.test`;
  await pool.query(
    `INSERT INTO users (email, password_hash, role, venue_id)
     VALUES ($1, (SELECT password_hash FROM users WHERE email = 'admin.a@atrium.test'),
             'VENUE_ADMIN', $2)`,
    [email, venueId],
  );

  customer = await login('customer@atrium.test');
  adminA = await login(email);
  adminB = await login('admin.b@atrium.test');
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
  return { status: res.status, body: await res.json().catch(() => ({})) as never };
}

async function hold(token: string, equipment: unknown[] = []): Promise<string> {
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
      equipment,
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe('GET /rooms/:id', () => {
  it('carries what a detail page needs, which availability does not', async () => {
    const res = await get(`/rooms/${roomId}`, customer);

    expect(res.status).toBe(200);
    const room = res.body as Record<string, unknown>;
    expect(room.name).toBe('Reads Studio');
    expect(room.venue_name).toBeTruthy();
    expect(room.capacity).toBe(12);
    expect(room.hourly_rate_minor).toBe(180_000);
    expect(room.amenities).toEqual(['wifi', 'piano']);
    // The hold path enforces these, so a client can disable a bad range early.
    expect(room.min_duration_min).toBe(60);
    expect(room.max_duration_min).toBe(480);
  });

  it('is not found for an admin of another venue (INV-6)', async () => {
    expect((await get(`/rooms/${roomId}`, adminB)).status).toBe(404);
  });
});

describe('GET /rooms/:id/equipment', () => {
  it('exposes the ids a hold needs, and the rate they are charged at', async () => {
    const res = await get(`/rooms/${roomId}/equipment`, customer);

    expect(res.status).toBe(200);
    const offers = res.body as Record<string, unknown>[];
    const camera = offers.find((o) => o.id === equipmentId);
    expect(camera).toBeTruthy();
    expect(camera!.name).toBe('Reads Camera');
    expect(camera!.hourly_rate_minor).toBe(25_000);
    expect(camera!.units_owned).toBe(4);
  });

  it('leaves the overbooking buffer out — it is not a customer\'s choice', async () => {
    const [offer] = await get(`/rooms/${roomId}/equipment`, customer)
      .then((r) => r.body as Record<string, unknown>[]);
    expect(offer).not.toHaveProperty('overbooking_buffer');
  });

  it('makes a hold with equipment reachable end to end', async () => {
    const offers = await get(`/rooms/${roomId}/equipment`, customer)
      .then((r) => r.body as { id: string }[]);

    const bookingId = await hold(customer, [{ equipmentTypeId: offers[0]!.id, quantity: 2 }]);

    const { rows } = await pool.query<{ quantity: number }>(
      'SELECT quantity FROM booking_line_items WHERE booking_id = $1', [bookingId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quantity).toBe(2);
  });

  it('is not found for an admin of another venue (INV-6)', async () => {
    expect((await get(`/rooms/${roomId}/equipment`, adminB)).status).toBe(404);
  });
});

describe('GET /bookings', () => {
  it('returns a customer their own booking, with the names a list needs', async () => {
    const id = await hold(customer);
    const { body: booking } = await get(`/bookings/${id}`, customer);
    const startedAt = Date.parse((booking as { start_at: string }).start_at);

    // Windowed rather than "the first page": on the full profile this customer
    // has bookings two years out, so a booking ten weeks away is nowhere near
    // the top of a start_at DESC page, and the assertion would depend on which
    // seed profile happened to be loaded.
    const res = await get(
      `/bookings?from=${encodeURIComponent(new Date(startedAt - 3_600_000).toISOString())}`
      + `&to=${encodeURIComponent(new Date(startedAt + 3_600_000).toISOString())}&limit=100`,
      customer,
    );
    expect(res.status).toBe(200);

    const mine = (res.body as Record<string, unknown>[]).find((b) => b.id === id);
    expect(mine).toBeTruthy();
    expect(mine!.room_name).toBe('Reads Studio');
    expect(mine!.venue_name).toBeTruthy();
  });

  it('orders newest first', async () => {
    const res = await get('/bookings?limit=50', customer);
    expect(res.status).toBe(200);

    const starts = (res.body as Record<string, unknown>[])
      .map((b) => new Date(b.start_at as string).getTime());
    expect([...starts].sort((a, b) => b - a)).toEqual(starts);
  });

  it('never shows a customer someone else\'s booking', async () => {
    const mine = await hold(customer);

    const other = await get('/bookings?limit=100', await login('customer0@atrium.test'));
    const ids = (other.body as { id: string }[]).map((b) => b.id);
    expect(ids).not.toContain(mine);
  });

  it('shows a venue admin their venue and nobody else\'s (INV-6)', async () => {
    const here = await hold(customer);

    const own = await get('/bookings?limit=100', adminA);
    expect((own.body as { id: string }[]).map((b) => b.id)).toContain(here);

    const elsewhere = await get('/bookings?limit=100', adminB);
    expect((elsewhere.body as { id: string }[]).map((b) => b.id)).not.toContain(here);
  });

  it('filters by status', async () => {
    const id = await hold(customer);
    await fetch(`${apiUrl}/bookings/${id}/cancel`, {
      method: 'POST', headers: { authorization: `Bearer ${customer}` },
    });

    const cancelled = await get('/bookings?status=CANCELLED&limit=100', customer);
    const ids = (cancelled.body as { id: string }[]).map((b) => b.id);
    expect(ids).toContain(id);

    const held = await get('/bookings?status=HELD&limit=100', customer);
    expect((held.body as { id: string }[]).map((b) => b.id)).not.toContain(id);
  });

  it('paginates', async () => {
    const first = await get('/bookings?limit=1', customer);
    const second = await get('/bookings?limit=1&offset=1', customer);

    expect((first.body as unknown[]).length).toBe(1);
    expect((second.body as { id: string }[])[0]?.id)
      .not.toBe((first.body as { id: string }[])[0]!.id);
  });

  it('refuses a window that ends before it starts', async () => {
    const now = new Date();
    const res = await get(
      `/bookings?from=${encodeURIComponent(now.toISOString())}`
      + `&to=${encodeURIComponent(new Date(now.getTime() - 3_600_000).toISOString())}`,
      customer,
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /venues/:id/policy', () => {
  it('gives a customer the terms they are agreeing to', async () => {
    const res = await get(`/venues/${venueId}/policy`, customer);

    expect(res.status).toBe(200);
    const policy = res.body as Record<string, unknown>;
    expect(policy.policy_version_id).toBeTruthy();
    expect(Array.isArray(policy.tiers)).toBe(true);
    expect((policy.tiers as { hours_before: number }[]).some((t) => t.hours_before === 0))
      .toBe(true);
  });

  it('follows the venue pointer after an admin publishes new terms', async () => {
    const before = await get(`/venues/${venueId}/policy`, adminA);

    await fetch(`${apiUrl}/venues/${venueId}/policy`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminA}` },
      body: JSON.stringify({
        tiers: [{ hours_before: 0, room_pct: 25, equipment_pct: 25 }],
      }),
    });

    const after = await get(`/venues/${venueId}/policy`, adminA);
    expect(after.body.policy_version_id).not.toBe(before.body.policy_version_id);
    expect((after.body as { tiers: { room_pct: number }[] }).tiers[0]!.room_pct).toBe(25);
  });

  it('is not found for an admin of another venue (INV-6)', async () => {
    expect((await get(`/venues/${venueId}/policy`, adminB)).status).toBe(404);
  });
});

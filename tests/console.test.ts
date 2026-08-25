/**
 * The venue console and the account surface.
 *
 * These are the writes a venue admin makes against their own inventory, and
 * they are the widest INV-6 surface in the system: every one of them names a
 * venue, a room or a user, and every one is checked against the caller's token
 * rather than against what the caller sent. Each write here has its negative
 * case beside it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { build } from '../src/server.js';
import { pool } from '../src/db/pool.js';

let app: FastifyInstance;
let platform: string;
let customer: string;
let adminA: string;
let adminB: string;
let staffA: string;
let venueId: string;
let roomId: string;
let equipmentId: string;
let adminAId: string;
// Hours from midnight today. Inside the 90 day advance window, and clear of the
// band tests/reads.test.ts uses.
let slotOffset = 1700;

const stamp = Date.now();
const OPEN_ALL_DAY = {
  mon: [['00:00', '23:59']], tue: [['00:00', '23:59']], wed: [['00:00', '23:59']],
  thu: [['00:00', '23:59']], fri: [['00:00', '23:59']], sat: [['00:00', '23:59']],
  sun: [['00:00', '23:59']],
};

beforeAll(async () => {
  app = await build();
  await app.ready();

  platform = await login('platform@atrium.test');
  customer = await login('customer@atrium.test');
  adminB = await login('admin.b@atrium.test');

  const created = await post('/venues', platform, {
    name: `Console fixture ${stamp}`,
    city: `Testopolis ${stamp}`,
    timezone: 'Asia/Karachi',
    operatingHours: OPEN_ALL_DAY,
  });
  expect(created.statusCode).toBe(201);
  venueId = json(created).id;

  // An admin and a staff member who belong to the fixture venue, so both sides
  // of every permission case are real accounts.
  const { rows: [admin] } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, venue_id)
     VALUES ($1, (SELECT password_hash FROM users WHERE email = 'admin.a@atrium.test'),
             'VENUE_ADMIN', $2) RETURNING id`,
    [`console-admin-${stamp}@atrium.test`, venueId],
  );
  adminAId = admin!.id;
  await pool.query(
    `INSERT INTO users (email, password_hash, role, venue_id)
     VALUES ($1, (SELECT password_hash FROM users WHERE email = 'admin.a@atrium.test'),
             'VENUE_STAFF', $2)`,
    [`console-staff-${stamp}@atrium.test`, venueId],
  );

  adminA = await login(`console-admin-${stamp}@atrium.test`);
  staffA = await login(`console-staff-${stamp}@atrium.test`);

  const room = await post(`/venues/${venueId}/rooms`, adminA, {
    name: 'Console Studio',
    capacity: 10,
    hourlyRateMinor: 120_000,
    amenities: ['wifi', 'booth'],
  });
  expect(room.statusCode).toBe(201);
  roomId = json(room).id;

  const kit = await post(`/venues/${venueId}/equipment`, adminA, {
    name: 'Console Mixer',
    hourlyRateMinor: 20_000,
    unitsOwned: 6,
    overbookingBuffer: 0.05,
  });
  expect(kit.statusCode).toBe(201);
  equipmentId = json(kit).id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('venue directory', () => {
  it('gives a customer every venue and a venue admin only their own', async () => {
    const all = json(await get('/venues', customer)) as { id: string }[];
    expect(all.length).toBeGreaterThan(1);
    expect(all.map((v) => v.id)).toContain(venueId);

    const mine = json(await get('/venues', adminA)) as { id: string }[];
    expect(mine.map((v) => v.id)).toEqual([venueId]);
  });

  it('filters by city and counts live rooms', async () => {
    const [venue] = json(await get(`/venues?city=${encodeURIComponent(`Testopolis ${stamp}`)}`,
      customer)) as { id: string; room_count: number }[];
    expect(venue!.id).toBe(venueId);
    expect(venue!.room_count).toBe(1);
  });

  it('is not found for an admin of another venue (INV-6)', async () => {
    expect((await get(`/venues/${venueId}`, adminB)).statusCode).toBe(404);
    expect((await get(`/venues/${venueId}`, adminA)).statusCode).toBe(200);
  });

  it('refuses a venue admin creating a venue', async () => {
    const res = await post('/venues', adminA, {
      name: 'Not mine', city: 'Nowhere', timezone: 'UTC', operatingHours: OPEN_ALL_DAY,
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a timezone Postgres would later choke on', async () => {
    const res = await post('/venues', platform, {
      name: 'Bad tz', city: 'Nowhere', timezone: 'Mars/Olympus', operatingHours: OPEN_ALL_DAY,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('venue settings', () => {
  it('carries a city change onto the rooms that denormalize it', async () => {
    const city = `Relocated ${stamp}`;
    expect((await patch(`/venues/${venueId}`, adminA, { city })).statusCode).toBe(200);

    const { rows } = await pool.query<{ city: string }>(
      'SELECT city FROM rooms WHERE id = $1', [roomId],
    );
    expect(rows[0]!.city).toBe(city);

    // And the search index answers for the new city, not the old one.
    const found = json(await get(`/rooms?city=${encodeURIComponent(city)}`, customer));
    expect(found.map((r: { id: string }) => r.id)).toContain(roomId);

    await patch(`/venues/${venueId}`, adminA, { city: `Testopolis ${stamp}` });
  });

  it('refuses venue staff, who may not change pricing or policy', async () => {
    expect((await patch(`/venues/${venueId}`, staffA, { name: 'Staff rename' })).statusCode)
      .toBe(403);
  });

  it('refuses an admin of another venue (INV-6)', async () => {
    expect((await patch(`/venues/${venueId}`, adminB, { name: 'Theirs now' })).statusCode)
      .toBe(403);
  });

  it('rejects operating hours that close before they open', async () => {
    const res = await patch(`/venues/${venueId}`, adminA, {
      operatingHours: { mon: [['18:00', '09:00']] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('rooms', () => {
  it('takes its city from the venue, not from the caller', async () => {
    const res = await post(`/venues/${venueId}/rooms`, adminA, {
      name: 'Second Studio', capacity: 4, hourlyRateMinor: 90_000, city: 'Spoofed',
    });
    expect(res.statusCode).toBe(201);
    expect(json(res).city).toBe(`Testopolis ${stamp}`);
  });

  it('reprices new bookings and leaves existing ones alone', async () => {
    const bookingId = await hold(customer);
    const { rows: [before] } = await pool.query<{ total_minor: number }>(
      'SELECT total_minor FROM bookings WHERE id = $1', [bookingId],
    );

    expect((await patch(`/rooms/${roomId}`, adminA, { hourlyRateMinor: 500_000 })).statusCode)
      .toBe(200);

    const { rows: [after] } = await pool.query<{ total_minor: number }>(
      'SELECT total_minor FROM bookings WHERE id = $1', [bookingId],
    );
    expect(after!.total_minor).toBe(before!.total_minor);

    await patch(`/rooms/${roomId}`, adminA, { hourlyRateMinor: 120_000 });
  });

  it('archives instead of deleting: the room leaves search and refuses new holds', async () => {
    const archived = json(await post(`/venues/${venueId}/rooms`, adminA, {
      name: 'Temporary Studio', capacity: 2, hourlyRateMinor: 60_000,
    })).id as string;

    expect((await patch(`/rooms/${archived}`, adminA, { active: false })).statusCode).toBe(200);

    expect((await get(`/rooms/${archived}`, customer)).statusCode).toBe(404);
    const res = await post('/bookings/hold', customer, { roomId: archived, ...slot() });
    expect(res.statusCode).toBe(404);

    // Still listed in the console, which is where it comes back from.
    const listed = json(await get(`/venues/${venueId}/rooms`, adminA));
    expect(listed.find((r: { id: string }) => r.id === archived)?.active).toBe(false);
  });

  it('refuses an admin of another venue and a staff member (INV-6)', async () => {
    expect((await patch(`/rooms/${roomId}`, adminB, { name: 'Theirs' })).statusCode).toBe(403);
    expect((await patch(`/rooms/${roomId}`, staffA, { name: 'Mine' })).statusCode).toBe(403);
    expect((await get(`/venues/${venueId}/rooms`, adminB)).statusCode).toBe(404);
  });

  it('lets staff read the console list, because they manage bookings against it', async () => {
    expect((await get(`/venues/${venueId}/rooms`, staffA)).statusCode).toBe(200);
  });
});

describe('equipment', () => {
  it('shows the buffer to the venue and hides it from the customer', async () => {
    const owned = json(await get(`/venues/${venueId}/equipment`, adminA));
    expect(owned.find((e: { id: string }) => e.id === equipmentId).overbooking_buffer)
      .toBe('0.050');

    const offers = json(await get(`/rooms/${roomId}/equipment`, customer));
    expect(offers.find((e: { id: string }) => e.id === equipmentId))
      .not.toHaveProperty('overbooking_buffer');
  });

  it('refuses to cut units below what future bookings already hold (INV-2)', async () => {
    await hold(customer, [{ equipmentTypeId: equipmentId, quantity: 4 }]);

    const tooFew = await patch(`/equipment/${equipmentId}`, adminA, { unitsOwned: 3 });
    expect(tooFew.statusCode).toBe(409);
    expect(json(tooFew).error).toBe('UNITS_COMMITTED');

    // Cutting to exactly what is committed is allowed; nothing is oversold.
    expect((await patch(`/equipment/${equipmentId}`, adminA, { unitsOwned: 4 })).statusCode)
      .toBe(200);
    await patch(`/equipment/${equipmentId}`, adminA, { unitsOwned: 6 });
  });

  it('rejects a buffer above the 10% the brief allows', async () => {
    expect((await patch(`/equipment/${equipmentId}`, adminA, { overbookingBuffer: 0.5 }))
      .statusCode).toBe(400);
  });

  it('archives equipment out of the offer list and out of new holds', async () => {
    const retired = json(await post(`/venues/${venueId}/equipment`, adminA, {
      name: 'Retired Light', hourlyRateMinor: 5_000, unitsOwned: 2,
    })).id as string;

    await patch(`/equipment/${retired}`, adminA, { active: false });

    const offers = json(await get(`/rooms/${roomId}/equipment`, customer)) as { id: string }[];
    expect(offers.map((e) => e.id)).not.toContain(retired);

    const res = await post('/bookings/hold', customer, {
      roomId, ...slot(), equipment: [{ equipmentTypeId: retired, quantity: 1 }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses an admin of another venue (INV-6)', async () => {
    expect((await patch(`/equipment/${equipmentId}`, adminB, { name: 'Theirs' })).statusCode)
      .toBe(403);
    expect((await get(`/venues/${venueId}/equipment`, adminB)).statusCode).toBe(404);
  });
});

describe('staff', () => {
  it('mints an account scoped to the admin own venue', async () => {
    const email = `minted-${stamp}@atrium.test`;
    const res = await post(`/venues/${venueId}/staff`, adminA, {
      email, password: 'atrium123', role: 'VENUE_STAFF',
    });
    expect(res.statusCode).toBe(201);
    expect(json(res).venue_id).toBe(venueId);

    // The account works, and it is scoped to the venue that created it.
    const token = await login(email, 'atrium123');
    const venues = json(await get('/venues', token)) as { id: string }[];
    expect(venues.map((v) => v.id)).toEqual([venueId]);
  });

  it('refuses to mint a platform admin from a venue account', async () => {
    const res = await post(`/venues/${venueId}/staff`, adminA, {
      email: `escalated-${stamp}@atrium.test`, password: 'atrium123', role: 'PLATFORM_ADMIN',
    });
    expect(res.statusCode).toBe(400);
  });

  it('deactivates an account, and the account can no longer log in', async () => {
    const email = `revoked-${stamp}@atrium.test`;
    const created = json(await post(`/venues/${venueId}/staff`, adminA, {
      email, password: 'atrium123', role: 'VENUE_STAFF',
    })).id as string;

    await login(email, 'atrium123');
    expect((await patch(`/venues/${venueId}/staff/${created}`, adminA, { active: false }))
      .statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST', url: '/auth/login', payload: { email, password: 'atrium123' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('will not let an admin lock themselves out', async () => {
    expect((await patch(`/venues/${venueId}/staff/${adminAId}`, adminA, { active: false }))
      .statusCode).toBe(403);
  });

  it('is closed to staff and to another venue admin (INV-6)', async () => {
    expect((await get(`/venues/${venueId}/staff`, staffA)).statusCode).toBe(403);
    expect((await get(`/venues/${venueId}/staff`, adminB)).statusCode).toBe(403);
  });
});

describe('accounts', () => {
  it('registers a customer and refuses the email twice', async () => {
    const email = `signup-${stamp}@atrium.test`;
    const first = await app.inject({
      method: 'POST', url: '/auth/register', payload: { email, password: 'atrium123' },
    });
    expect(first.statusCode).toBe(201);
    expect(json(first).user.role).toBe('CUSTOMER');

    const again = await app.inject({
      method: 'POST', url: '/auth/register', payload: { email, password: 'atrium123' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('tells a client who it is talking to', async () => {
    const me = json(await get('/auth/me', adminA));
    expect(me.role).toBe('VENUE_ADMIN');
    expect(me.email).toBe(`console-admin-${stamp}@atrium.test`);
    expect(me.venueName).toBe(`Console fixture ${stamp}`);

    expect(json(await get('/auth/me', customer)).venueName).toBeNull();
  });

  it('changes a password only when the current one is given', async () => {
    const email = `rotate-${stamp}@atrium.test`;
    await app.inject({
      method: 'POST', url: '/auth/register', payload: { email, password: 'atrium123' },
    });
    const token = await login(email, 'atrium123');

    expect((await patch('/auth/password', token,
      { currentPassword: 'wrong-one', newPassword: 'atrium456' })).statusCode).toBe(401);

    expect((await patch('/auth/password', token,
      { currentPassword: 'atrium123', newPassword: 'atrium456' })).statusCode).toBe(200);

    await login(email, 'atrium456');
    const stale = await app.inject({
      method: 'POST', url: '/auth/login', payload: { email, password: 'atrium123' },
    });
    expect(stale.statusCode).toBe(401);
  });
});

describe('booking detail and audit trail', () => {
  it('carries line items, the terms agreed to, and no payment yet', async () => {
    const bookingId = await hold(customer, [{ equipmentTypeId: equipmentId, quantity: 1 }]);

    const detail = json(await get(`/bookings/${bookingId}`, customer));
    expect(detail.room.name).toBe('Console Studio');
    expect(detail.lineItems).toHaveLength(1);
    expect(detail.lineItems[0].name).toBe('Console Mixer');
    expect(detail.payment).toBeNull();
    expect(detail.refund).toBeNull();
    expect(detail.policy.tiers.some((t: { hours_before: number }) => t.hours_before === 0))
      .toBe(true);
  });

  it('records every state the booking has been in, in order', async () => {
    const bookingId = await hold(customer);
    await post(`/bookings/${bookingId}/cancel`, customer, {});

    const trail = json(await get(`/bookings/${bookingId}/audit`, customer));

    expect(trail.map((a: { from_state: string; to_state: string }) => [a.from_state, a.to_state]))
      .toEqual([[null, 'HELD'], ['HELD', 'CANCELLED']]);
  });

  it('is not readable for a booking the caller cannot see (INV-6)', async () => {
    const bookingId = await hold(customer);
    expect((await get(`/bookings/${bookingId}/audit`, adminB)).statusCode).toBe(404);
  });
});

describe('revenue and utilisation', () => {
  const range = () => {
    const to = new Date(Date.now() + 120 * 86_400_000).toISOString();
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString();
    return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  };

  it('reports money and utilisation for one venue', async () => {
    const res = await get(`/reports/revenue?venueId=${venueId}&${range()}`, adminA);
    expect(res.statusCode).toBe(200);

    const report = json(res);
    expect(report.venueName).toBe(`Console fixture ${stamp}`);
    expect(report.revenue.netMinor)
      .toBe(report.revenue.grossMinor - report.revenue.refundedMinor);
    // The fixture venue is open around the clock, so the denominator is real.
    expect(report.utilisation.openHours).toBeGreaterThan(0);
    expect(report.byRoom.length).toBe(report.utilisation.rooms);
  });

  it('refuses a customer, and hides another venue behind a 404 (INV-6)', async () => {
    expect((await get(`/reports/revenue?venueId=${venueId}&${range()}`, customer)).statusCode)
      .toBe(403);
    expect((await get(`/reports/revenue?venueId=${venueId}&${range()}`, adminB)).statusCode)
      .toBe(404);
  });

  it('rejects a window that ends before it starts', async () => {
    const now = new Date();
    const backwards = `from=${encodeURIComponent(now.toISOString())}`
      + `&to=${encodeURIComponent(new Date(now.getTime() - 3_600_000).toISOString())}`;
    expect((await get(`/reports/revenue?venueId=${venueId}&${backwards}`, adminA)).statusCode)
      .toBe(400);
  });
});

describe('search facets', () => {
  it('lists the cities and amenities behind the filters', async () => {
    const facets = json(await get('/rooms/facets', customer));
    expect(facets.cities).toContain(`Testopolis ${stamp}`);
    expect(facets.amenities).toContain('booth');
  });
});

async function login(email: string, password = 'atrium123'): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed for ${email}: ${res.body}`);
  return JSON.parse(res.body).token;
}

const get = (url: string, token: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

const post = (url: string, token: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload });

const patch = (url: string, token: string, payload: unknown) =>
  app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}` }, payload });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: { body: string }): any => JSON.parse(res.body);

/** Two hours apart: one hour would collide with the 15 minute turnaround. */
function slot() {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const start = new Date(midnight.getTime() + slotOffset * 3_600_000);
  slotOffset += 2;
  return {
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 3_600_000).toISOString(),
  };
}

async function hold(token: string, equipment: unknown[] = []): Promise<string> {
  const res = await post('/bookings/hold', token, { roomId, ...slot(), equipment });
  if (res.statusCode !== 201) throw new Error(`hold failed: ${res.body}`);
  return JSON.parse(res.body).id;
}

/**
 * REQUIRED NEGATIVE TEST  (INV-6, hard cap)
 *
 * A VENUE_ADMIN of Venue A must receive 403 or 404, and never data, when
 * requesting a booking, room or report belonging to Venue B -- including when
 * they have a valid Venue B UUID in hand.
 *
 * Runs in process against a seeded database. Authorisation is asserted at the
 * API surface, because authorisation that lives only in the frontend is
 * treated as absent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { build } from '../src/server.js';
import { pool } from '../src/db/pool.js';

let app: FastifyInstance;
let adminA: string;
let adminB: string;
let customer: string;

/** A booking that genuinely belongs to venue B, and its real UUID. */
let venueBBookingId: string;
let venueBRoomId: string;
let venueABookingId: string;

beforeAll(async () => {
  app = await build();
  await app.ready();

  adminA = await login('admin.a@atrium.test');
  adminB = await login('admin.b@atrium.test');
  customer = await login('customer@atrium.test');

  const { rows: venues } = await pool.query<{ id: string }>(
    'SELECT id FROM venues ORDER BY created_at LIMIT 2',
  );
  const [venueA, venueB] = venues;
  if (!venueA || !venueB) throw new Error('seed the database first');

  venueBBookingId = (await one(
    'SELECT id FROM bookings WHERE venue_id = $1 LIMIT 1', [venueB.id],
  )).id;
  venueBRoomId = (await one(
    'SELECT id FROM rooms WHERE venue_id = $1 LIMIT 1', [venueB.id],
  )).id;
  venueABookingId = (await one(
    'SELECT id FROM bookings WHERE venue_id = $1 LIMIT 1', [venueA.id],
  )).id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('cross-venue isolation', () => {
  it('venue A admin cannot read a venue B booking by its real UUID', async () => {
    const res = await get(`/bookings/${venueBBookingId}`, adminA);

    // The UUID is real and the booking exists. 404 rather than 403 is
    // deliberate: 403 would confirm the resource exists (A8).
    expect([403, 404]).toContain(res.statusCode);
    expect(res.body).not.toContain(venueBBookingId);
  });

  it('venue A admin CAN read their own venue booking', async () => {
    const res = await get(`/bookings/${venueABookingId}`, adminA);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe(venueABookingId);
  });

  it('venue B admin can read what venue A admin cannot', async () => {
    // Proves the previous refusal is scoping, not a broken or missing row.
    const res = await get(`/bookings/${venueBBookingId}`, adminB);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe(venueBBookingId);
  });

  it('venue A admin cannot hold a room in venue B', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/bookings/hold',
      headers: { authorization: `Bearer ${adminA}` },
      payload: {
        roomId: venueBRoomId,
        startAt: slot().startAt,
        endAt: slot().endAt,
        equipment: [],
      },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('a customer cannot read another user booking', async () => {
    const res = await get(`/bookings/${venueBBookingId}`, customer);
    expect([403, 404]).toContain(res.statusCode);
  });

  it('no token is rejected', async () => {
    const res = await app.inject({ method: 'GET', url: `/bookings/${venueBBookingId}` });
    expect(res.statusCode).toBe(401);
  });

  it('a forged token with another venue id is rejected', async () => {
    // Signed with the wrong secret: the scope is only ever built from a
    // verified token, never from anything the caller supplies.
    const forged = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'x', role: 'PLATFORM_ADMIN', venueId: null }))
        .toString('base64url'),
      'not-a-valid-signature',
    ].join('.');

    const res = await get(`/bookings/${venueBBookingId}`, forged);
    expect(res.statusCode).toBe(401);
  });
});

async function login(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: 'atrium123' },
  });
  if (res.statusCode !== 200) throw new Error(`login failed for ${email}: ${res.body}`);
  return JSON.parse(res.body).token;
}

const get = (url: string, token: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

async function one(sql: string, params: unknown[]): Promise<{ id: string }> {
  const { rows } = await pool.query<{ id: string }>(sql, params);
  if (!rows[0]) throw new Error(`fixture query returned nothing: ${sql}`);
  return rows[0];
}

function slot() {
  const base = Math.ceil((Date.now() + 30 * 3_600_000) / 1_800_000) * 1_800_000;
  const at = new Date(base);
  at.setUTCHours(9, 0, 0, 0);
  return {
    startAt: at.toISOString(),
    endAt: new Date(at.getTime() + 3_600_000).toISOString(),
  };
}

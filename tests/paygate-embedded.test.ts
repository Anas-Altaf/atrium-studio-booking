/**
 * The provider mounted in the API process, which is how the deployed instance
 * runs it. Two free services sleep on their own schedules; one does not.
 *
 * The loop never leaves the process: the worker calls this app's own
 * /paygate/charges, and the callback comes back to its own /webhooks/paygate.
 *
 * Every src import is dynamic. `config` is read at module load, so a static
 * import anywhere in this file would capture the environment before the flags
 * below are set.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

const PORT = 4100;
const apiUrl = `http://127.0.0.1:${PORT}`;

let app: FastifyInstance;
let pool: pg.Pool;
let jobs: typeof import('../src/worker/jobs.js');
let token: string;
let roomId: string;

const OPEN_ALL_DAY = {
  mon: [['00:00', '23:59']], tue: [['00:00', '23:59']], wed: [['00:00', '23:59']],
  thu: [['00:00', '23:59']], fri: [['00:00', '23:59']], sat: [['00:00', '23:59']],
  sun: [['00:00', '23:59']],
};

beforeAll(async () => {
  process.env.PAYGATE_EMBEDDED = 'on';
  process.env.PAYGATE_CHAOS = 'off';
  process.env.PORT = String(PORT);
  process.env.PAYGATE_CALLBACK_URL = `${apiUrl}/webhooks/paygate`;

  ({ pool } = await import('../src/db/pool.js'));
  jobs = await import('../src/worker/jobs.js');
  const { build } = await import('../src/server.js');

  app = await build();
  await app.listen({ port: PORT, host: '127.0.0.1' });

  const { rows: [venue] } = await pool.query<{ id: string }>(
    `INSERT INTO venues (name, city, timezone, operating_hours, current_policy_version_id)
     VALUES ($1, 'Karachi', 'Asia/Karachi', $2,
             (SELECT id FROM refund_policy_versions
              WHERE venue_id IS NULL ORDER BY created_at DESC LIMIT 1))
     RETURNING id`,
    [`Embedded fixture ${Date.now()}`, JSON.stringify(OPEN_ALL_DAY)],
  );
  const { rows: [room] } = await pool.query<{ id: string }>(
    `INSERT INTO rooms (venue_id, name, capacity, hourly_rate_minor, amenities, city)
     VALUES ($1, 'Embedded Studio', 10, 150000, '{}', 'Karachi') RETURNING id`,
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
  await app.close();
  await pool.end();
  delete process.env.PAYGATE_EMBEDDED;
  delete process.env.PAYGATE_CHAOS;
  delete process.env.PORT;
  delete process.env.PAYGATE_CALLBACK_URL;
});

describe('the provider mounted in the API', () => {
  it('answers on /paygate/health without shadowing the API health check', async () => {
    const api = await fetch(`${apiUrl}/health`).then((r) => r.json()) as Record<string, unknown>;
    expect(api.database).toBe('reachable');

    const provider = await fetch(`${apiUrl}/paygate/health`)
      .then((r) => r.json()) as Record<string, unknown>;
    expect(provider.status).toBe('ok');
  });

  it('takes a booking to CONFIRMED without leaving the process', async () => {
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    const start = new Date(midnight.getTime() + 1400 * 3_600_000);

    const held = await fetch(`${apiUrl}/bookings/hold`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        roomId,
        startAt: start.toISOString(),
        endAt: new Date(start.getTime() + 3_600_000).toISOString(),
        equipment: [],
      }),
    });
    expect(held.status).toBe(201);
    const bookingId = ((await held.json()) as { id: string }).id;

    await fetch(`${apiUrl}/bookings/${bookingId}/pay`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    });

    // The worker posts to this same app, and the callback returns to it.
    await jobs.submitPendingCharges();

    const deadline = Date.now() + 4_000;
    let status = '';
    while (Date.now() < deadline) {
      await jobs.processWebhooks();
      const { rows } = await pool.query<{ status: string }>(
        'SELECT status FROM bookings WHERE id = $1', [bookingId],
      );
      status = rows[0]!.status;
      if (status === 'CONFIRMED') break;
      await new Promise((r) => { setTimeout(r, 25); });
    }

    expect(status).toBe('CONFIRMED');
  });
});

/**
 * The reaper, and the reason it exists.
 *
 * Nothing expires by the passage of time: the exclusion constraint's WHERE
 * cannot reference now(), so a hold past its TTL keeps blocking its slot until
 * something moves it. Left unrun, 6,401 of them accumulated locally and the
 * concurrency proof began failing on 504s while INV-1 itself still held.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { reapHolds } from '../src/worker/jobs.js';

const OPEN_ALL_DAY = {
  mon: [['00:00', '23:59']], tue: [['00:00', '23:59']], wed: [['00:00', '23:59']],
  thu: [['00:00', '23:59']], fri: [['00:00', '23:59']], sat: [['00:00', '23:59']],
  sun: [['00:00', '23:59']],
};

let roomId: string;
let userId: string;
let policyId: string;
let slotOffset = 200;

beforeAll(async () => {
  const { rows: [venue] } = await pool.query<{ id: string; policy: string }>(
    `INSERT INTO venues (name, city, timezone, operating_hours, current_policy_version_id)
     VALUES ($1, 'Karachi', 'Asia/Karachi', $2,
             (SELECT id FROM refund_policy_versions
              WHERE venue_id IS NULL ORDER BY created_at DESC LIMIT 1))
     RETURNING id, current_policy_version_id AS policy`,
    [`Reaper fixture ${Date.now()}`, JSON.stringify(OPEN_ALL_DAY)],
  );
  policyId = venue!.policy;

  const { rows: [room] } = await pool.query<{ id: string }>(
    `INSERT INTO rooms (venue_id, name, capacity, hourly_rate_minor, amenities, city)
     VALUES ($1, 'Reaper Studio', 10, 100000, '{}', 'Karachi') RETURNING id`,
    [venue!.id],
  );
  roomId = room!.id;

  const { rows: [user] } = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE email = 'customer@atrium.test'`,
  );
  userId = user!.id;
});

afterAll(async () => {
  await pool.end();
});

/** `expiresInMinutes` may be negative, which is the whole point. */
async function booking(status: string, expiresInMinutes: number): Promise<string> {
  const start = slotOffset;
  slotOffset += 2;

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO bookings
       (venue_id, room_id, user_id, status, start_at, end_at,
        expires_at, policy_version_id, total_minor)
     VALUES ((SELECT venue_id FROM rooms WHERE id = $1), $1, $2, $3::booking_status,
             date_trunc('hour', now()) + ($4 || ' hours')::interval,
             date_trunc('hour', now()) + ($5 || ' hours')::interval,
             now() + ($6 || ' minutes')::interval,
             $7, 100000)
     RETURNING id`,
    [roomId, userId, status, String(start), String(start + 1),
     String(expiresInMinutes), policyId],
  );
  return rows[0]!.id;
}

const statusOf = async (id: string): Promise<string> => (await pool.query<{ status: string }>(
  'SELECT status FROM bookings WHERE id = $1', [id],
)).rows[0]!.status;

const auditCount = async (id: string): Promise<number> => Number(
  (await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM audit_events WHERE booking_id = $1', [id],
  )).rows[0]!.n,
);

describe('reapHolds', () => {
  it('expires a HELD booking past its TTL', async () => {
    const id = await booking('HELD', -1);
    await reapHolds();
    expect(await statusOf(id)).toBe('EXPIRED');
  });

  /**
   * The state INV-4 is about. 007 indexed only HELD, so the one case the
   * invariant turns on was the one the reaper could not find.
   */
  it('expires a PENDING_PAYMENT booking past its TTL', async () => {
    const id = await booking('PENDING_PAYMENT', -1);
    await reapHolds();
    expect(await statusOf(id)).toBe('EXPIRED');
  });

  it('leaves a live hold alone', async () => {
    const id = await booking('HELD', 30);
    await reapHolds();
    expect(await statusOf(id)).toBe('HELD');
  });

  it('writes exactly one audit event per expiry, with no actor', async () => {
    const id = await booking('HELD', -1);
    await reapHolds();

    const { rows } = await pool.query<{ from_state: string; actor_id: string | null; reason: string }>(
      `SELECT from_state, actor_id, reason FROM audit_events
       WHERE booking_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [id],
    );
    expect(await auditCount(id)).toBe(2);        // the insert, then the expiry
    expect(rows[0]!.from_state).toBe('HELD');
    expect(rows[0]!.actor_id).toBeNull();        // the reaper is the system
    expect(rows[0]!.reason).toBe('hold TTL elapsed');
  });

  it('is safe to run twice — the second pass finds nothing to do', async () => {
    const id = await booking('HELD', -1);
    await reapHolds();
    const after = await auditCount(id);

    await reapHolds();

    expect(await statusOf(id)).toBe('EXPIRED');
    expect(await auditCount(id)).toBe(after);
  });

  it('releases the slot it was holding', async () => {
    const id = await booking('HELD', -1);

    // The exclusion constraint covers HELD, so the slot is taken.
    const { rows: [held] } = await pool.query<{ start_at: Date; end_at: Date }>(
      'SELECT start_at, end_at FROM bookings WHERE id = $1', [id],
    );
    const overlapping = () => pool.query(
      `INSERT INTO bookings
         (venue_id, room_id, user_id, status, start_at, end_at,
          expires_at, policy_version_id, total_minor)
       VALUES ((SELECT venue_id FROM rooms WHERE id = $1), $1, $2, 'HELD', $3, $4,
               now() + interval '8 minutes', $5, 100000)`,
      [roomId, userId, held!.start_at, held!.end_at, policyId],
    );

    await expect(overlapping()).rejects.toMatchObject({ code: '23P01' });

    await reapHolds();

    // EXPIRED is outside the constraint's WHERE, so the slot is free again.
    await expect(overlapping()).resolves.toBeTruthy();
  });
});

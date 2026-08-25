/**
 * REQUIRED — unit tests over the state machine.
 *
 * The matrix is enforced by a BEFORE UPDATE trigger, so a booking cannot be put
 * into a state by updating it: the reset is itself a transition and is checked
 * like any other. Each case therefore inserts its own booking directly in the
 * state under test — INSERT is audited but not validated against the matrix.
 *
 * Every booking gets its own slot on a room this file creates. Sharing a seeded
 * room means colliding with the seeded calendar through the exclusion
 * constraint.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';

const ATR01 = 'ATR01';
const OPEN_ALL_DAY = {
  mon: [['00:00', '23:59']], tue: [['00:00', '23:59']], wed: [['00:00', '23:59']],
  thu: [['00:00', '23:59']], fri: [['00:00', '23:59']], sat: [['00:00', '23:59']],
  sun: [['00:00', '23:59']],
};

let roomId: string;
let userId: string;
let policyId: string;
let slotOffset = 2;

beforeAll(async () => {
  const { rows: [venue] } = await pool.query<{ id: string; policy: string }>(
    `INSERT INTO venues (name, city, timezone, operating_hours, current_policy_version_id)
     VALUES ($1, 'Karachi', 'Asia/Karachi', $2,
             (SELECT id FROM refund_policy_versions
              WHERE venue_id IS NULL ORDER BY created_at DESC LIMIT 1))
     RETURNING id, current_policy_version_id AS policy`,
    [`State machine fixture ${Date.now()}`, JSON.stringify(OPEN_ALL_DAY)],
  );
  policyId = venue!.policy;

  const { rows: [room] } = await pool.query<{ id: string }>(
    `INSERT INTO rooms (venue_id, name, capacity, hourly_rate_minor, amenities, city)
     VALUES ($1, 'Fixture Studio', 10, 100000, '{}', 'Karachi') RETURNING id`,
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

/**
 * A booking already in `status`, on a slot no other booking holds.
 *
 * HELD carries an expiry because `held_has_expiry` requires one; the others do
 * not, so the column is left null and the CHECK is satisfied either way.
 */
async function bookingIn(status: string): Promise<string> {
  const start = slotOffset;
  slotOffset += 2;

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO bookings
       (venue_id, room_id, user_id, status, start_at, end_at,
        expires_at, policy_version_id, total_minor)
     VALUES ((SELECT venue_id FROM rooms WHERE id = $1), $1, $2, $3::booking_status,
             date_trunc('hour', now()) + ($4 || ' hours')::interval,
             date_trunc('hour', now()) + ($5 || ' hours')::interval,
             CASE WHEN $3 = 'HELD' THEN now() + interval '8 minutes' END,
             $6, 100000)
     RETURNING id`,
    [roomId, userId, status, String(start), String(start + 1), policyId],
  );
  return rows[0]!.id;
}

/** A hold always carries a TTL — `held_has_expiry` refuses one without it. */
const move = (id: string, from: string, to: string) => pool.query(
  `UPDATE bookings
   SET    status = $3::booking_status,
          expires_at = CASE WHEN $3::text = 'HELD'
                            THEN now() + interval '8 minutes'
                            ELSE expires_at END
   WHERE  id = $1 AND status = $2::booking_status`,
  [id, from, to],
);

const auditOf = async (id: string) => (await pool.query<{
  from_state: string | null; to_state: string; actor_id: string | null; reason: string;
}>(
  `SELECT from_state, to_state, actor_id, reason FROM audit_events
   WHERE booking_id = $1 ORDER BY occurred_at, id`,
  [id],
)).rows;

describe('legal transitions', () => {
  const legal: [string, string][] = [
    ['DRAFT', 'HELD'],
    ['DRAFT', 'EXPIRED'],
    ['HELD', 'PENDING_PAYMENT'],
    ['HELD', 'EXPIRED'],
    ['HELD', 'CANCELLED'],
    ['PENDING_PAYMENT', 'CONFIRMED'],
    ['PENDING_PAYMENT', 'FAILED'],
    ['PENDING_PAYMENT', 'EXPIRED'],
    ['CONFIRMED', 'COMPLETED'],
    ['CONFIRMED', 'CANCELLED'],
    ['CANCELLED', 'REFUNDED'],
    ['EXPIRED', 'REFUNDED'],
  ];

  it.each(legal)('%s → %s is allowed', async (from, to) => {
    const id = await bookingIn(from);
    const { rowCount } = await move(id, from, to);
    expect(rowCount).toBe(1);
  });

  it('HELD → HELD re-issues the TTL without changing state (A1)', async () => {
    const id = await bookingIn('HELD');
    const { rowCount } = await pool.query(
      `UPDATE bookings SET expires_at = now() + interval '10 minutes'
       WHERE id = $1 AND status = 'HELD'`,
      [id],
    );
    expect(rowCount).toBe(1);

    // The checkout window is a real transition, audited like any other.
    const audit = await auditOf(id);
    expect(audit.map((r) => `${r.from_state ?? '-'}>${r.to_state}`))
      .toEqual(['->HELD', 'HELD>HELD']);
  });
});

describe('illegal transitions', () => {
  const illegal: [string, string][] = [
    ['CONFIRMED', 'DRAFT'],
    ['COMPLETED', 'CANCELLED'],
    ['CANCELLED', 'CONFIRMED'],
    ['FAILED', 'PENDING_PAYMENT'],
    ['EXPIRED', 'HELD'],
    ['REFUNDED', 'CONFIRMED'],
    ['COMPLETED', 'PENDING_PAYMENT'],
  ];

  it.each(illegal)('%s → %s raises ATR01', async (from, to) => {
    const id = await bookingIn(from);
    await expect(move(id, from, to)).rejects.toMatchObject({ code: ATR01 });
  });

  /**
   * INV-4's refusal half. A capture arriving after the hold expired must not
   * confirm the booking; the money is returned through EXPIRED → REFUNDED
   * instead, which the legal set above covers.
   */
  it('EXPIRED → CONFIRMED raises ATR01', async () => {
    const id = await bookingIn('EXPIRED');
    await expect(move(id, 'EXPIRED', 'CONFIRMED')).rejects.toMatchObject({ code: ATR01 });
  });

  it('a refused transition leaves the row and the trail untouched', async () => {
    const id = await bookingIn('CONFIRMED');
    const before = await auditOf(id);

    await expect(move(id, 'CONFIRMED', 'DRAFT')).rejects.toMatchObject({ code: ATR01 });

    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM bookings WHERE id = $1', [id],
    );
    expect(rows[0]!.status).toBe('CONFIRMED');
    expect(await auditOf(id)).toHaveLength(before.length);
  });
});

describe('audit trail', () => {
  it('writes exactly one event per transition, in order', async () => {
    const id = await bookingIn('DRAFT');
    await move(id, 'DRAFT', 'HELD');
    await move(id, 'HELD', 'PENDING_PAYMENT');
    await move(id, 'PENDING_PAYMENT', 'CONFIRMED');
    await move(id, 'CONFIRMED', 'CANCELLED');

    const audit = await auditOf(id);
    expect(audit.map((r) => `${r.from_state ?? '-'}>${r.to_state}`)).toEqual([
      '->DRAFT',
      'DRAFT>HELD',
      'HELD>PENDING_PAYMENT',
      'PENDING_PAYMENT>CONFIRMED',
      'CONFIRMED>CANCELLED',
    ]);
  });

  it('an update that changes no state writes nothing', async () => {
    const id = await bookingIn('CONFIRMED');
    const before = await auditOf(id);

    await pool.query(
      `UPDATE bookings SET total_minor = total_minor + 1 WHERE id = $1`, [id],
    );

    expect(await auditOf(id)).toHaveLength(before.length);
  });

  /**
   * The actor and reason are set with `set_config(..., true)` — transaction
   * local. Both statements have to be on the same client inside one
   * transaction, which is what `withTransaction` does for the application.
   */
  it('records the actor and reason from the transaction', async () => {
    const actor = userId;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('atrium.actor_id', $1, true),
                set_config('atrium.reason', 'hold created', true)`,
        [actor],
      );

      const { rows: [booking] } = await client.query<{ id: string }>(
        `INSERT INTO bookings
           (venue_id, room_id, user_id, status, start_at, end_at,
            expires_at, policy_version_id, total_minor)
         VALUES ((SELECT venue_id FROM rooms WHERE id = $1), $1, $2, 'HELD',
                 date_trunc('hour', now()) + interval '80 hours',
                 date_trunc('hour', now()) + interval '81 hours',
                 now() + interval '8 minutes', $3, 100000)
         RETURNING id`,
        [roomId, actor, policyId],
      );

      await client.query(
        `UPDATE bookings SET status = 'PENDING_PAYMENT' WHERE id = $1 AND status = 'HELD'`,
        [booking!.id],
      );
      await client.query('COMMIT');

      const audit = await auditOf(booking!.id);
      expect(audit).toHaveLength(2);
      for (const row of audit) {
        expect(row.actor_id).toBe(actor);
        expect(row.reason).toBe('hold created');
      }
    } finally {
      client.release();
    }
  });

  it('records the system as a null actor when none is set', async () => {
    const id = await bookingIn('HELD');
    await move(id, 'HELD', 'EXPIRED');

    const audit = await auditOf(id);
    expect(audit.at(-1)!.to_state).toBe('EXPIRED');
    expect(audit.at(-1)!.actor_id).toBeNull();
    expect(audit.at(-1)!.reason).toBe('unspecified');
  });
});

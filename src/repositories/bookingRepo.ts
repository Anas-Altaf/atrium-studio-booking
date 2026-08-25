/**
 * Booking writes and reads. SQL only.
 *
 * The hold's business rules — interval validation, pricing, capacity, the venue
 * check — used to live here alongside the queries. They are now in
 * `domain/booking.ts` and `services/bookingService.ts`; what is left is the
 * persistence.
 */
import { query } from '../db/pool.js';
import type { Tx } from '../db/pool.js';
import { type AuthScope, scopePredicate } from '../auth/scope.js';
import type { BookingRow, EquipmentLine } from '../domain/types.js';

export interface NewHold {
  venueId: string;
  roomId: string;
  userId: string;
  startAt: string;
  endAt: string;
  expiresAt: string;
  policyVersionId: string;
  totalMinor: number;
}

/**
 * INV-1 is settled by this statement. There is no prior SELECT for conflicts,
 * because the check and the write are the same operation: the exclusion
 * constraint rejects an overlap with 23P01, which `translatePgError` turns into
 * a 409. A read-then-write would leave a window between them.
 */
export async function insertHold(tx: Tx, hold: NewHold): Promise<BookingRow> {
  const { rows } = await tx.query<BookingRow>(
    `INSERT INTO bookings
       (venue_id, room_id, user_id, status, start_at, end_at,
        expires_at, policy_version_id, total_minor)
     VALUES ($1, $2, $3, 'HELD', $4, $5, $6, $7, $8)
     RETURNING id, venue_id, room_id, user_id, status,
               start_at, end_at, expires_at, policy_version_id, total_minor`,
    [hold.venueId, hold.roomId, hold.userId, hold.startAt, hold.endAt,
     hold.expiresAt, hold.policyVersionId, hold.totalMinor],
  );
  return rows[0]!;
}

export async function insertLineItem(
  tx: Tx, bookingId: string, line: EquipmentLine, hourlyRateMinor: number,
): Promise<void> {
  await tx.query(
    `INSERT INTO booking_line_items
       (booking_id, equipment_type_id, quantity, hourly_rate_minor)
     VALUES ($1, $2, $3, $4)`,
    [bookingId, line.equipmentTypeId, line.quantity, hourlyRateMinor],
  );
}

/**
 * A booking by id, visible only within the caller's scope (INV-6).
 *
 * The scope is applied in the predicate rather than checked after the read, so
 * a booking belonging to another venue is not found rather than found and then
 * refused.
 */
export async function findById(scope: AuthScope, id: string): Promise<BookingRow | undefined> {
  const pred = scopePredicate(scope, { venue: 'b.venue_id', user: 'b.user_id' }, 2);
  const rows = await query<BookingRow>(
    `SELECT b.id, b.venue_id, b.room_id, b.user_id, b.status, b.start_at, b.end_at,
            b.expires_at, b.policy_version_id, b.total_minor
     FROM   bookings b
     WHERE  b.id = $1 AND ${pred.sql}`,
    [id, ...pred.params],
  );
  return rows[0];
}

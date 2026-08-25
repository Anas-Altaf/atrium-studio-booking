import { query } from '../db/pool.js';
import type { Tx } from '../db/pool.js';
import { type AuthScope, venuePredicate } from '../auth/scope.js';
import type { RoomRow, RoomSearch, RoomSearchRow } from '../domain/types.js';

/**
 * INV-6 in the predicate rather than in the caller: a venue-scoped caller finds
 * nothing, which the service reports as 404 — the same answer as a room that
 * does not exist, so the response cannot be used to probe room ids (A8).
 */
export async function findForBooking(
  scope: AuthScope, tx: Tx, roomId: string,
): Promise<RoomRow | undefined> {
  const pred = venuePredicate(scope, 'venue_id', 2);
  const { rows } = await tx.query<RoomRow>(
    `SELECT id, venue_id, capacity, hourly_rate_minor, min_duration_min, max_duration_min
     FROM   rooms WHERE id = $1 AND ${pred.sql}`,
    [roomId, ...pred.params],
  );
  return rows[0];
}

/** Outside a transaction, for reads that are not part of a hold. */
export async function findVisible(
  scope: AuthScope, roomId: string,
): Promise<{ id: string; venue_id: string } | undefined> {
  const pred = venuePredicate(scope, 'venue_id', 2);
  const rows = await query<{ id: string; venue_id: string }>(
    `SELECT id, venue_id FROM rooms WHERE id = $1 AND ${pred.sql}`,
    [roomId, ...pred.params],
  );
  return rows[0];
}

export interface BusyInterval { start_at: Date; end_at: Date; status: string }

/**
 * What is taken on one room over a window.
 *
 * Reads the same partial GiST index the exclusion constraint uses, so
 * "is this room free" and "may this booking be inserted" are the same question
 * asked of the same structure. The range carries the 15 minute turnaround, so
 * a caller deriving free slots gets the gap for nothing.
 */
export async function busyIntervals(
  scope: AuthScope, roomId: string, from: string, to: string,
): Promise<BusyInterval[]> {
  const pred = venuePredicate(scope, 'b.venue_id', 4);
  return query<BusyInterval>(
    `SELECT b.start_at, b.end_at, b.status
     FROM   bookings b
     WHERE  b.room_id = $1
       AND  b.status IN ('HELD','PENDING_PAYMENT','CONFIRMED')
       AND  b.reserved_range && tstzrange($2, $3, '[)')
       AND  ${pred.sql}
     ORDER  BY b.start_at`,
    [roomId, from, to, ...pred.params],
  );
}

/**
 * Cross-venue search. The cheap predicates on `rooms` are written first and the
 * availability test last; measured on the full profile the planner does not run
 * them in that order (LOAD_TEST.md).
 */
export async function search(scope: AuthScope, s: RoomSearch): Promise<RoomSearchRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;

  const pred = venuePredicate(scope, 'r.venue_id', params.length + 1);
  if (pred.params.length) { params.push(...pred.params); where.push(pred.sql); }

  if (s.city) where.push(`r.city = ${p(s.city)}`);
  if (s.minCapacity !== undefined) where.push(`r.capacity >= ${p(s.minCapacity)}`);
  if (s.maxPriceMinor !== undefined) where.push(`r.hourly_rate_minor <= ${p(s.maxPriceMinor)}`);
  if (s.amenities?.length) where.push(`r.amenities @> ${p(s.amenities)}::text[]`);

  if (s.from && s.to) {
    where.push(`NOT EXISTS (
      SELECT 1 FROM bookings b
      WHERE  b.room_id = r.id
        AND  b.status IN ('HELD','PENDING_PAYMENT','CONFIRMED')
        AND  b.reserved_range && tstzrange(${p(s.from)}, ${p(s.to)}, '[)')
    )`);
  }

  return query<RoomSearchRow>(
    `SELECT r.id, r.venue_id, r.name, r.city, r.capacity,
            r.hourly_rate_minor, r.amenities
     FROM   rooms r
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER  BY r.hourly_rate_minor, r.id
     LIMIT  ${p(s.limit)}`,
    params,
  );
}

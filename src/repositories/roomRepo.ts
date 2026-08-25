/**
 * Room reads. SQL only.
 */
import { query } from '../db/pool.js';
import type { Tx } from '../db/pool.js';
import { type AuthScope, venuePredicate } from '../auth/scope.js';
import type { RoomRow, RoomSearch, RoomSearchRow } from '../domain/types.js';

/**
 * The columns the hold path needs, inside the caller's transaction.
 *
 * Scoped in SQL rather than checked by the caller afterwards. It read any
 * venue's room and left the venue check to the one service that happened to
 * perform it — which made INV-6, a scoring hard cap, depend on every future
 * caller remembering. A venue-scoped caller now finds nothing, which the
 * service reports as 404: the same answer as a room that does not exist, so the
 * response cannot be used to discover which room ids are real (A8).
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

/**
 * Cross-venue search (ARCHITECTURE.md 5).
 *
 * Filter order is the design, not incidental. The cheap predicates on `rooms`
 * are written first and the availability test last, because availability is the
 * only one that touches `bookings` -- 250,000 rows on the full profile against
 * 800 rooms. Measured on the full profile the planner does not execute them in
 * that order; see LOAD_TEST.md.
 *
 * Scope: only venue-scoped roles are confined to their own venue. Searching
 * across venues is the whole point of the endpoint for a customer, and a
 * platform admin is unrestricted.
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

  // Availability last, and only when a window was asked for.
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

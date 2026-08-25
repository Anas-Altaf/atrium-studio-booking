import { query } from '../db/pool.js';
import type { Tx } from '../db/pool.js';
import { type AuthScope, venuePredicate } from '../auth/scope.js';
import type { RoomAdminRow, RoomRow, RoomSearch, RoomSearchRow } from '../domain/types.js';

const ADMIN_COLUMNS = `id, venue_id, name, city, capacity, hourly_rate_minor,
                       amenities, min_duration_min, max_duration_min, active`;

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
     FROM   rooms WHERE id = $1 AND active AND ${pred.sql}`,
    [roomId, ...pred.params],
  );
  return rows[0];
}

/** A venue's own view: archived rooms included, because a console has to un-archive them. */
export async function listForVenue(venueId: string): Promise<RoomAdminRow[]> {
  return query<RoomAdminRow>(
    `SELECT ${ADMIN_COLUMNS} FROM rooms WHERE venue_id = $1 ORDER BY name`,
    [venueId],
  );
}

export interface NewRoom {
  venueId: string;
  name: string;
  capacity: number;
  hourlyRateMinor: number;
  amenities: string[];
  minDurationMin: number;
  maxDurationMin: number;
}

/** `city` is copied from the venue, never taken from the caller — it is denormalized, not input. */
export async function insert(tx: Tx, room: NewRoom): Promise<RoomAdminRow> {
  const { rows } = await tx.query<RoomAdminRow>(
    `INSERT INTO rooms (venue_id, name, capacity, hourly_rate_minor, amenities,
                        city, min_duration_min, max_duration_min)
     VALUES ($1, $2, $3, $4, $5, (SELECT city FROM venues WHERE id = $1), $6, $7)
     RETURNING ${ADMIN_COLUMNS}`,
    [room.venueId, room.name, room.capacity, room.hourlyRateMinor,
     room.amenities, room.minDurationMin, room.maxDurationMin],
  );
  return rows[0]!;
}

export interface RoomPatch {
  name?: string;
  capacity?: number;
  hourlyRateMinor?: number;
  amenities?: string[];
  minDurationMin?: number;
  maxDurationMin?: number;
  active?: boolean;
}

/**
 * A rate change reaches new bookings only: `booking_line_items` and
 * `bookings.total_minor` freeze the price at hold, so nothing here can reprice
 * a booking that already exists.
 */
export async function update(
  tx: Tx, roomId: string, patch: RoomPatch,
): Promise<RoomAdminRow | undefined> {
  const sets: string[] = [];
  const params: unknown[] = [roomId];
  const p = (v: unknown) => `$${params.push(v)}`;

  if (patch.name !== undefined) sets.push(`name = ${p(patch.name)}`);
  if (patch.capacity !== undefined) sets.push(`capacity = ${p(patch.capacity)}`);
  if (patch.hourlyRateMinor !== undefined) {
    sets.push(`hourly_rate_minor = ${p(patch.hourlyRateMinor)}`);
  }
  if (patch.amenities !== undefined) sets.push(`amenities = ${p(patch.amenities)}`);
  if (patch.minDurationMin !== undefined) {
    sets.push(`min_duration_min = ${p(patch.minDurationMin)}`);
  }
  if (patch.maxDurationMin !== undefined) {
    sets.push(`max_duration_min = ${p(patch.maxDurationMin)}`);
  }
  if (patch.active !== undefined) sets.push(`active = ${p(patch.active)}`);

  const { rows } = await tx.query<RoomAdminRow>(
    sets.length
      ? `UPDATE rooms SET ${sets.join(', ')} WHERE id = $1 RETURNING ${ADMIN_COLUMNS}`
      : `SELECT ${ADMIN_COLUMNS} FROM rooms WHERE id = $1`,
    params,
  );
  return rows[0];
}

/**
 * Names for a booking that already belongs to the caller. No `active` filter:
 * a booking on a room the venue has since retired must still say where it is.
 */
export async function findNamed(
  roomId: string,
): Promise<{ id: string; name: string; venue_name: string; city: string } | undefined> {
  const rows = await query<{ id: string; name: string; venue_name: string; city: string }>(
    `SELECT r.id, r.name, r.city, v.name AS venue_name
     FROM   rooms r JOIN venues v ON v.id = r.venue_id
     WHERE  r.id = $1`,
    [roomId],
  );
  return rows[0];
}

/** The venue a room belongs to, so a write can be checked against the caller's scope. */
export async function venueOf(roomId: string): Promise<string | undefined> {
  const rows = await query<{ venue_id: string }>(
    'SELECT venue_id FROM rooms WHERE id = $1', [roomId],
  );
  return rows[0]?.venue_id;
}

/** Distinct cities and amenities across the live catalogue, for search filters. */
export async function facets(): Promise<{ cities: string[]; amenities: string[] }> {
  const [cities, amenities] = await Promise.all([
    query<{ city: string }>('SELECT DISTINCT city FROM rooms WHERE active ORDER BY city'),
    query<{ amenity: string }>(
      `SELECT DISTINCT unnest(amenities) AS amenity
       FROM   rooms WHERE active ORDER BY amenity`,
    ),
  ]);
  return { cities: cities.map((c) => c.city), amenities: amenities.map((a) => a.amenity) };
}

export interface RoomDetail extends RoomSearchRow {
  venue_name: string;
  min_duration_min: number;
  max_duration_min: number;
}

/** Outside a transaction, for reads that are not part of a hold. */
export async function findVisible(
  scope: AuthScope, roomId: string,
): Promise<{ id: string; venue_id: string } | undefined> {
  const pred = venuePredicate(scope, 'venue_id', 2);
  const rows = await query<{ id: string; venue_id: string }>(
    `SELECT id, venue_id FROM rooms WHERE id = $1 AND active AND ${pred.sql}`,
    [roomId, ...pred.params],
  );
  return rows[0];
}

/**
 * One room, with what a detail page needs. The availability endpoint answers
 * "when", not "what", so a deep link to a room has nowhere else to get its
 * name, rate or duration bounds.
 */
export async function findDetail(
  scope: AuthScope, roomId: string,
): Promise<RoomDetail | undefined> {
  const pred = venuePredicate(scope, 'r.venue_id', 2);
  const rows = await query<RoomDetail>(
    `SELECT r.id, r.venue_id, r.name, r.city, r.capacity, r.hourly_rate_minor,
            r.amenities, r.min_duration_min, r.max_duration_min,
            v.name AS venue_name
     FROM   rooms r
     JOIN   venues v ON v.id = r.venue_id
     WHERE  r.id = $1 AND r.active AND ${pred.sql}`,
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

  // Matches the partial index, so archived rooms leave the index rather than
  // being filtered out of it.
  where.push('r.active');
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

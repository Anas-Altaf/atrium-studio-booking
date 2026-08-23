import { query } from '../db/pool.js';
import { type AuthScope, isVenueScoped } from '../auth/scope.js';

export interface RoomSearchRow {
  id: string;
  venue_id: string;
  name: string;
  city: string;
  capacity: number;
  hourly_rate_minor: number;
  amenities: string[];
}

export interface RoomSearch {
  city?: string;
  minCapacity?: number;
  maxPriceMinor?: number;
  amenities?: string[];
  from?: string;
  to?: string;
  limit: number;
}

/**
 * Cross-venue search (ARCHITECTURE.md 5).
 *
 * Filter order is the design, not incidental. The cheap predicates on `rooms`
 * run first and the availability test runs last, because availability is the
 * only one that touches `bookings` -- 250,000 rows on the full profile against
 * 800 rooms -- so every room eliminated earlier is a range lookup not performed.
 *
 * Scope: only venue-scoped roles are confined to their own venue. Searching
 * across venues is the whole point of the endpoint for a customer, and a
 * platform admin is unrestricted.
 */
export async function searchRooms(
  scope: AuthScope,
  s: RoomSearch,
): Promise<RoomSearchRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;

  if (isVenueScoped(scope)) where.push(`r.venue_id = ${p(scope.venueId)}`);
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

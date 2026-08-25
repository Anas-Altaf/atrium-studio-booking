import { query } from '../db/pool.js';
import { type AuthScope, venuePredicate } from '../auth/scope.js';

export interface Discrepancy {
  kind: string;
  id: string;
  detail: string;
}

/**
 * INV-5, as three anti-joins and one open question. Each names money present in
 * one place and absent from the other it should match; zero rows across all
 * four is the invariant holding.
 */
export async function discrepancies(scope: AuthScope): Promise<Discrepancy[]> {
  const pred = venuePredicate(scope, 'b.venue_id', 1);
  const params = pred.params;

  // COMPLETED counts with CONFIRMED: it is a confirmed booking whose end time
  // passed, and the money is kept for the same reason (A13).

  // 1. Money taken for a booking that neither happened nor was refunded.
  const stranded = await query<Discrepancy>(
    `SELECT 'CAPTURE_WITHOUT_OUTCOME' AS kind, p.id::text AS id,
            'booking ' || b.id || ' is ' || b.status AS detail
     FROM   payments p
     JOIN   bookings b ON b.id = p.booking_id
     WHERE  p.status = 'CAPTURED'
       AND  b.status NOT IN ('CONFIRMED', 'COMPLETED')
       AND  NOT EXISTS (SELECT 1 FROM refunds r WHERE r.booking_id = b.id)
       AND  ${pred.sql}`,
    params,
  );

  // 2. A slot given away: a booking that happened with no captured charge.
  const unpaid = await query<Discrepancy>(
    `SELECT 'CONFIRMED_WITHOUT_CAPTURE' AS kind, b.id::text AS id,
            b.status || ' with no captured payment' AS detail
     FROM   bookings b
     WHERE  b.status IN ('CONFIRMED', 'COMPLETED')
       AND  NOT EXISTS (SELECT 1 FROM payments p
                        WHERE p.booking_id = b.id AND p.status = 'CAPTURED')
       AND  ${pred.sql}`,
    params,
  );

  // 3. A refund against a charge that was never captured.
  const orphanRefunds = await query<Discrepancy>(
    `SELECT 'REFUND_WITHOUT_CAPTURE' AS kind, r.id::text AS id,
            'payment ' || p.id || ' is ' || p.status AS detail
     FROM   refunds r
     JOIN   payments p ON p.id = r.payment_id
     JOIN   bookings b ON b.id = r.booking_id
     WHERE  p.status <> 'CAPTURED'
       AND  ${pred.sql}`,
    params,
  );

  // 4. A callback naming a charge never recorded. Unmatched means no venue yet,
  //    so only a platform admin is shown them.
  const unmatched = scope.role === 'PLATFORM_ADMIN'
    ? await query<Discrepancy>(
      `SELECT 'UNMATCHED_CALLBACK' AS kind, u.id::text AS id,
              'charge ' || u.charge_id AS detail
       FROM   unmatched_webhooks u
       WHERE  u.resolved_at IS NULL
         AND  NOT EXISTS (SELECT 1 FROM payments p WHERE p.charge_id = u.charge_id)`,
    )
    : [];

  return [...stranded, ...unpaid, ...orphanRefunds, ...unmatched];
}

export interface MoneyTally {
  captured_minor: number;
  refunded_minor: number;
  confirmed_bookings: number;
}

/** What the ledger says, so the zero above is read against something. */
export async function tally(scope: AuthScope): Promise<MoneyTally> {
  const pred = venuePredicate(scope, 'b.venue_id', 1);

  const [money] = await query<{ captured_minor: number; confirmed_bookings: number }>(
    `SELECT COALESCE(SUM(p.amount_minor) FILTER (WHERE p.status = 'CAPTURED'), 0)::bigint
              AS captured_minor,
            count(DISTINCT b.id) FILTER (WHERE b.status = 'CONFIRMED')::int
              AS confirmed_bookings
     FROM   bookings b
     LEFT JOIN payments p ON p.booking_id = b.id
     WHERE  ${pred.sql}`,
    pred.params,
  );

  const [returned] = await query<{ refunded_minor: number }>(
    `SELECT COALESCE(SUM(r.amount_minor), 0)::bigint AS refunded_minor
     FROM   refunds r
     JOIN   bookings b ON b.id = r.booking_id
     WHERE  r.status = 'SUCCEEDED' AND ${pred.sql}`,
    pred.params,
  );

  return { ...money!, ...returned! };
}

export interface RoomRevenue {
  room_id: string;
  room_name: string;
  bookings: number;
  gross_minor: number;
  booked_hours: number;
}

export interface VenueRevenue {
  gross_minor: number;
  refunded_minor: number;
  paid_bookings: number;
  booked_hours: number;
  rooms: number;
  by_room: RoomRevenue[];
}

/**
 * Money first, sales second.
 *
 * Gross is what the provider captured, not the sum of booking totals: a booking
 * cancelled after capture with a partial refund keeps the part that was not
 * returned, and a totals-based figure would drop it entirely when the status
 * left CONFIRMED. Utilisation counts only CONFIRMED and COMPLETED, because that
 * is the inventory actually consumed.
 *
 * Bucketed by `start_at`, so a booking belongs to the period it occupies rather
 * than the one it was paid in.
 */
export async function venueRevenue(
  venueId: string, from: string, to: string,
): Promise<VenueRevenue> {
  const window = [venueId, from, to];

  const [captured, returned, byRoom] = await Promise.all([
    query<{ gross_minor: number; paid_bookings: number }>(
      `SELECT COALESCE(SUM(p.amount_minor), 0)::bigint AS gross_minor,
              count(DISTINCT b.id)::int               AS paid_bookings
       FROM   bookings b
       JOIN   payments p ON p.booking_id = b.id AND p.status = 'CAPTURED'
       WHERE  b.venue_id = $1 AND b.start_at >= $2 AND b.start_at < $3`,
      window,
    ),
    query<{ refunded_minor: number }>(
      `SELECT COALESCE(SUM(r.amount_minor), 0)::bigint AS refunded_minor
       FROM   refunds r
       JOIN   bookings b ON b.id = r.booking_id
       WHERE  r.status = 'SUCCEEDED'
         AND  b.venue_id = $1 AND b.start_at >= $2 AND b.start_at < $3`,
      window,
    ),
    query<RoomRevenue>(
      `SELECT r.id AS room_id, r.name AS room_name,
              count(b.id)::int                          AS bookings,
              COALESCE(SUM(b.total_minor), 0)::bigint   AS gross_minor,
              COALESCE(SUM(EXTRACT(EPOCH FROM (b.end_at - b.start_at)) / 3600),
                       0)::float8                       AS booked_hours
       FROM   rooms r
       LEFT   JOIN bookings b
         ON   b.room_id = r.id
        AND   b.status IN ('CONFIRMED', 'COMPLETED')
        AND   b.start_at >= $2 AND b.start_at < $3
       WHERE  r.venue_id = $1 AND r.active
       GROUP  BY r.id, r.name
       ORDER  BY gross_minor DESC, r.name`,
      window,
    ),
  ]);

  return {
    ...captured[0]!,
    ...returned[0]!,
    rooms: byRoom.length,
    booked_hours: byRoom.reduce((sum, r) => sum + r.booked_hours, 0),
    by_room: byRoom,
  };
}

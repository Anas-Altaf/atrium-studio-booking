import type { Tx } from '../db/pool.js';
import type { EquipmentTypeRow } from '../domain/types.js';

/**
 * `ORDER BY id` is not cosmetic: two concurrent holds naming the same two types
 * in opposite order deadlock. The caller sorts the ids too — ORDER BY only
 * fixes the order within one statement.
 */
export async function lockTypes(
  tx: Tx, ids: string[], venueId: string,
): Promise<EquipmentTypeRow[]> {
  const { rows } = await tx.query<EquipmentTypeRow>(
    `SELECT id, venue_id, hourly_rate_minor, units_owned, overbooking_buffer
     FROM   equipment_types
     WHERE  id = ANY($1::uuid[]) AND venue_id = $2
     ORDER  BY id
     FOR    UPDATE`,
    [ids, venueId],
  );
  return rows;
}

/**
 * Peak concurrent reservation per type over the interval.
 *
 * A sum of overlapping quantities would count units never out at the same
 * moment. Usage is a step function that changes only at booking boundaries, so
 * the maximum over the requested start plus every overlapping start is exact.
 *
 * `points` seeds one row per requested type, so a type with no overlapping
 * bookings still comes back, at zero.
 */
export async function peakUsage(
  tx: Tx, typeIds: string[], startAt: string, endAt: string,
): Promise<Map<string, number>> {
  if (typeIds.length === 0) return new Map();

  const { rows } = await tx.query<{ type_id: string; peak: number }>(
    `WITH requested AS (
       SELECT unnest($1::uuid[]) AS type_id
     ),
     points AS (
       SELECT r.type_id, $2::timestamptz AS t FROM requested r
       UNION
       SELECT li.equipment_type_id, b.start_at
       FROM   booking_line_items li
       JOIN   bookings b ON b.id = li.booking_id
       WHERE  li.equipment_type_id = ANY($1::uuid[])
         AND  b.status IN ('HELD','PENDING_PAYMENT','CONFIRMED')
         AND  b.start_at >= $2 AND b.start_at < $3
     ),
     usage AS (
       SELECT p.type_id, p.t, COALESCE(SUM(li.quantity), 0) AS units
       FROM   points p
       LEFT JOIN bookings b
         ON  b.status IN ('HELD','PENDING_PAYMENT','CONFIRMED')
         AND b.start_at <= p.t AND b.end_at > p.t
       LEFT JOIN booking_line_items li
         ON  li.booking_id = b.id AND li.equipment_type_id = p.type_id
       GROUP BY p.type_id, p.t
     )
     SELECT type_id, COALESCE(MAX(units), 0)::int AS peak
     FROM   usage
     GROUP  BY type_id`,
    [typeIds, startAt, endAt],
  );

  return new Map(rows.map((r) => [r.type_id, r.peak]));
}

/**
 * Venue reads. SQL only — every decision made on these rows lives in
 * `domain/booking.ts`.
 */
import type { Tx } from '../db/pool.js';
import { notFound, unavailable } from '../errors.js';
import type { LocalWindow } from '../domain/types.js';

/**
 * The requested interval expressed in the venue's own local time, together with
 * that venue's published hours.
 *
 * `AT TIME ZONE` rather than an offset computed in Node: Postgres owns the
 * timezone database, so DST across Karachi, Dubai and London is its problem and
 * not a hand-rolled table that goes stale.
 */
export async function localWindow(
  tx: Tx, venueId: string, startAt: string, endAt: string,
): Promise<LocalWindow> {
  const { rows } = await tx.query<LocalWindow>(
    `SELECT lower(to_char($2::timestamptz AT TIME ZONE v.timezone, 'dy')) AS dow,
            to_char($2::timestamptz AT TIME ZONE v.timezone, 'HH24:MI')   AS local_start,
            to_char($3::timestamptz AT TIME ZONE v.timezone, 'HH24:MI')   AS local_end,
            v.operating_hours                                             AS hours
     FROM   venues v WHERE v.id = $1`,
    [venueId, startAt, endAt],
  );

  const row = rows[0];
  if (!row) throw notFound('venue not found');
  return row;
}

/**
 * The policy version in force for this venue right now.
 *
 * Falls back to the platform default, which is itself a version row, so a venue
 * that has never published its own tiers still points at something real (4B).
 */
export async function currentPolicyVersion(tx: Tx, venueId: string): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT COALESCE(
              (SELECT current_policy_version_id FROM venues WHERE id = $1),
              (SELECT id FROM refund_policy_versions
               WHERE venue_id IS NULL ORDER BY created_at DESC LIMIT 1)
            ) AS id`,
    [venueId],
  );
  // Reachable when migrations have run but the seed has not: a fresh database,
  // or a deploy whose seed step was skipped. It answered 500 on the first hold,
  // which reads as a defect in the hold path rather than an unseeded database.
  if (!rows[0]?.id) {
    throw unavailable('NO_REFUND_POLICY',
      'No refund policy version exists. The database has not been seeded.');
  }
  return rows[0].id;
}

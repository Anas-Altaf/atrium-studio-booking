import { query } from '../db/pool.js';
import type { Tx } from '../db/pool.js';
import { notFound, unavailable } from '../errors.js';
import type { LocalWindow, OperatingHours, RefundTier } from '../domain/types.js';

/**
 * The interval in the venue's local time. `AT TIME ZONE` rather than an offset
 * computed in Node, so DST across Karachi, Dubai and London is Postgres's
 * problem.
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

export interface PublishedPolicy {
  policy_version_id: string;
  tiers: RefundTier[];
  published_at: Date;
}

/**
 * The terms a venue is publishing right now, for a customer to read before
 * booking and an admin to read before editing. Not the terms of any existing
 * booking — those come from its own version.
 */
export async function currentPolicy(venueId: string): Promise<PublishedPolicy | undefined> {
  const rows = await query<PublishedPolicy>(
    `SELECT p.id AS policy_version_id, p.tiers, p.created_at AS published_at
     FROM   venues v
     JOIN   refund_policy_versions p ON p.id = v.current_policy_version_id
     WHERE  v.id = $1`,
    [venueId],
  );
  return rows[0];
}

/** No scope: a venue's published hours are not tenant data. */
export async function operatingHours(venueId: string): Promise<OperatingHours | null> {
  const rows = await query<{ operating_hours: OperatingHours }>(
    'SELECT operating_hours FROM venues WHERE id = $1',
    [venueId],
  );
  return rows[0]?.operating_hours ?? null;
}

/**
 * Read through the booking's own `policy_version_id`, never the venue's current
 * pointer — that is what keeps a policy published today off a booking made last
 * week (4B).
 */
export async function tiersOf(tx: Tx, policyVersionId: string): Promise<RefundTier[]> {
  const { rows } = await tx.query<{ tiers: RefundTier[] }>(
    'SELECT tiers FROM refund_policy_versions WHERE id = $1',
    [policyVersionId],
  );
  if (!rows[0]) throw notFound('refund policy version not found');
  return rows[0].tiers;
}

/** Versions are immutable (008 rejects an UPDATE), so an edit is an insert. */
export async function publishPolicy(
  tx: Tx, venueId: string, tiers: RefundTier[],
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO refund_policy_versions (venue_id, tiers) VALUES ($1, $2) RETURNING id`,
    [venueId, JSON.stringify(tiers)],
  );
  await tx.query(
    'UPDATE venues SET current_policy_version_id = $2 WHERE id = $1',
    [venueId, rows[0]!.id],
  );
  return rows[0]!.id;
}

/** Falls back to the platform default, which is itself a version row (4B). */
export async function currentPolicyVersion(tx: Tx, venueId: string): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT COALESCE(
              (SELECT current_policy_version_id FROM venues WHERE id = $1),
              (SELECT id FROM refund_policy_versions
               WHERE venue_id IS NULL ORDER BY created_at DESC LIMIT 1)
            ) AS id`,
    [venueId],
  );

  // Reachable when migrations have run but the seed has not.
  if (!rows[0]?.id) {
    throw unavailable('NO_REFUND_POLICY',
      'No refund policy version exists. The database has not been seeded.');
  }
  return rows[0].id;
}

import { query } from '../db/pool.js';
import type { Tx } from '../db/pool.js';
import { type AuthScope, venuePredicate } from '../auth/scope.js';
import { notFound, unavailable } from '../errors.js';
import type {
  LocalWindow, OperatingHours, RefundTier, StaffRow, VenueRow,
} from '../domain/types.js';

const VENUE_COLUMNS = 'id, name, city, timezone, operating_hours';

export interface VenueListRow extends VenueRow {
  room_count: number;
}

/**
 * The venue directory. A customer sees every venue — the catalogue is
 * cross-venue by design — and a venue-scoped caller sees only their own, so the
 * same list drives both a city picker and a console's venue switcher.
 */
export async function list(scope: AuthScope, city?: string): Promise<VenueListRow[]> {
  const params: unknown[] = [];
  const where: string[] = [];

  const pred = venuePredicate(scope, 'v.id', params.length + 1);
  if (pred.params.length) { params.push(...pred.params); where.push(pred.sql); }
  if (city) where.push(`v.city = $${params.push(city)}`);

  return query<VenueListRow>(
    `SELECT v.id, v.name, v.city, v.timezone, v.operating_hours,
            (SELECT count(*) FROM rooms r WHERE r.venue_id = v.id AND r.active)::int
              AS room_count
     FROM   venues v
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER  BY v.city, v.name`,
    params,
  );
}

export async function findById(scope: AuthScope, id: string): Promise<VenueRow | undefined> {
  const pred = venuePredicate(scope, 'id', 2);
  const rows = await query<VenueRow>(
    `SELECT ${VENUE_COLUMNS} FROM venues WHERE id = $1 AND ${pred.sql}`,
    [id, ...pred.params],
  );
  return rows[0];
}

export interface NewVenue {
  name: string;
  city: string;
  timezone: string;
  operatingHours: OperatingHours;
}

/** Starts on the platform default policy; publishing tiers moves the pointer. */
export async function insert(tx: Tx, v: NewVenue): Promise<VenueRow> {
  const { rows } = await tx.query<VenueRow>(
    `INSERT INTO venues (name, city, timezone, operating_hours, current_policy_version_id)
     VALUES ($1, $2, $3, $4,
             (SELECT id FROM refund_policy_versions
              WHERE venue_id IS NULL ORDER BY created_at DESC LIMIT 1))
     RETURNING ${VENUE_COLUMNS}`,
    [v.name, v.city, v.timezone, JSON.stringify(v.operatingHours)],
  );
  return rows[0]!;
}

export type VenuePatch = Partial<NewVenue>;

/**
 * `rooms.city` is denormalized from here so cross-venue search filters without
 * a join. Moving a venue has to carry its rooms with it, in the same
 * transaction, or the search index starts answering for the old city.
 */
export async function update(tx: Tx, id: string, patch: VenuePatch): Promise<VenueRow | undefined> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const p = (v: unknown) => `$${params.push(v)}`;

  if (patch.name !== undefined) sets.push(`name = ${p(patch.name)}`);
  if (patch.city !== undefined) sets.push(`city = ${p(patch.city)}`);
  if (patch.timezone !== undefined) sets.push(`timezone = ${p(patch.timezone)}`);
  if (patch.operatingHours !== undefined) {
    sets.push(`operating_hours = ${p(JSON.stringify(patch.operatingHours))}`);
  }
  if (!sets.length) return findByIdUnscoped(tx, id);

  const { rows } = await tx.query<VenueRow>(
    `UPDATE venues SET ${sets.join(', ')} WHERE id = $1 RETURNING ${VENUE_COLUMNS}`,
    params,
  );
  if (rows[0] && patch.city !== undefined) {
    await tx.query('UPDATE rooms SET city = $2 WHERE venue_id = $1', [id, patch.city]);
  }
  return rows[0];
}

/** The caller has already been checked against this venue id by `requireVenueAdmin`. */
async function findByIdUnscoped(tx: Tx, id: string): Promise<VenueRow | undefined> {
  const { rows } = await tx.query<VenueRow>(
    `SELECT ${VENUE_COLUMNS} FROM venues WHERE id = $1`, [id],
  );
  return rows[0];
}

/** No scope: the caller is already inside this venue, by their own token. */
export async function nameOf(venueId: string): Promise<string | null> {
  const rows = await query<{ name: string }>('SELECT name FROM venues WHERE id = $1', [venueId]);
  return rows[0]?.name ?? null;
}

export async function staff(venueId: string): Promise<StaffRow[]> {
  return query<StaffRow>(
    `SELECT id, email, role, venue_id, active, created_at
     FROM   users WHERE venue_id = $1 ORDER BY email`,
    [venueId],
  );
}

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

/** The same read outside a transaction, for a booking page quoting its own terms. */
export async function tiersOfVersion(policyVersionId: string): Promise<RefundTier[]> {
  const rows = await query<{ tiers: RefundTier[] }>(
    'SELECT tiers FROM refund_policy_versions WHERE id = $1',
    [policyVersionId],
  );
  return rows[0]?.tiers ?? [];
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

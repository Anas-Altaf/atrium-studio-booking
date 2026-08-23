import type { Tx } from '../db/pool.js';
import { query, withTransaction } from '../db/pool.js';
import { type AuthScope, assertVenueWritable, scopePredicate } from '../auth/scope.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { config } from '../config.js';

export interface BookingRow {
  id: string;
  venue_id: string;
  room_id: string;
  user_id: string;
  status: string;
  start_at: Date;
  end_at: Date;
  expires_at: Date | null;
  policy_version_id: string;
  total_minor: number;
}

export interface HoldRequest {
  roomId: string;
  startAt: string;
  endAt: string;
  equipment: { equipmentTypeId: string; quantity: number }[];
}

/**
 * Creates a hold over a room and, optionally, equipment.
 *
 * Both invariants are settled inside this one transaction:
 *
 *   INV-1  the INSERT is checked by the exclusion constraint. There is no
 *          prior SELECT for conflicts, because the check and the write are the
 *          same operation. A lost race raises 23P01, translated to 409.
 *
 *   INV-2  the equipment_types rows are locked FOR UPDATE, then peak
 *          concurrent usage is evaluated over the requested interval. A sum of
 *          overlapping quantities would be wrong: overlaps are partial.
 *
 * Lock ordering: equipment_types are locked first, always sorted by id, and
 * only then is the booking inserted. A fixed global order is what keeps two
 * concurrent holds over the same two equipment types from deadlocking.
 */
export async function createHold(
  scope: AuthScope,
  req: HoldRequest,
): Promise<BookingRow> {
  return withTransaction({ actorId: scope.userId, reason: 'hold created' }, async (tx) => {
    const room = await loadRoomForBooking(tx, req.roomId);
    if (!room) throw notFound('room not found');

    validateInterval(req.startAt, req.endAt, room.min_duration_min, room.max_duration_min);
    await assertInsideOperatingHours(tx, room.venue_id, req.startAt, req.endAt);

    // Equipment must belong to the room's venue (A6), and locking happens
    // before the booking insert, in id order (see note above).
    const typeIds = [...new Set(req.equipment.map((e) => e.equipmentTypeId))].sort();
    const locked = typeIds.length
      ? await lockEquipmentTypes(tx, typeIds, room.venue_id)
      : [];

    if (locked.length !== typeIds.length) {
      throw badRequest('UNKNOWN_EQUIPMENT', 'Equipment does not belong to this venue.');
    }

    for (const line of req.equipment) {
      const type = locked.find((t) => t.id === line.equipmentTypeId)!;
      await assertEquipmentAdmissible(tx, type, line.quantity, req.startAt, req.endAt);
    }

    const policyVersionId = await currentPolicyVersion(tx, room.venue_id);
    const expiresAt = new Date(Date.now() + config.holdTtlMinutes * 60_000).toISOString();
    const totalMinor = priceOf(room, locked, req);

    const [booking] = await tx.query<BookingRow>(
      `INSERT INTO bookings
         (venue_id, room_id, user_id, status, start_at, end_at,
          expires_at, policy_version_id, total_minor)
       VALUES ($1, $2, $3, 'HELD', $4, $5, $6, $7, $8)
       RETURNING id, venue_id, room_id, user_id, status,
                 start_at, end_at, expires_at, policy_version_id, total_minor`,
      [room.venue_id, req.roomId, scope.userId, req.startAt, req.endAt,
       expiresAt, policyVersionId, totalMinor],
    ).then((r) => r.rows);

    for (const line of req.equipment) {
      const type = locked.find((t) => t.id === line.equipmentTypeId)!;
      await tx.query(
        `INSERT INTO booking_line_items
           (booking_id, equipment_type_id, quantity, hourly_rate_minor)
         VALUES ($1, $2, $3, $4)`,
        [booking!.id, line.equipmentTypeId, line.quantity, type.hourly_rate_minor],
      );
    }

    return booking!;
  });
}

interface RoomRow {
  id: string; venue_id: string; capacity: number; hourly_rate_minor: number;
  min_duration_min: number; max_duration_min: number;
}

async function loadRoomForBooking(tx: Tx, roomId: string): Promise<RoomRow | undefined> {
  const { rows } = await tx.query<RoomRow>(
    `SELECT id, venue_id, capacity, hourly_rate_minor, min_duration_min, max_duration_min
     FROM rooms WHERE id = $1`,
    [roomId],
  );
  return rows[0];
}

interface EquipmentTypeRow {
  id: string; venue_id: string; hourly_rate_minor: number;
  units_owned: number; overbooking_buffer: string;
}

async function lockEquipmentTypes(
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
 * The interval peak check.
 *
 * Usage is a step function that only changes at booking boundaries, so it is
 * enough to evaluate the requested start plus the start of every overlapping
 * booking that falls inside the window, and take the maximum.
 */
async function assertEquipmentAdmissible(
  tx: Tx,
  type: EquipmentTypeRow,
  requestedQty: number,
  startAt: string,
  endAt: string,
): Promise<void> {
  const { rows } = await tx.query<{ peak: number }>(
    `WITH points AS (
       SELECT $2::timestamptz AS t
       UNION
       SELECT b.start_at
       FROM   booking_line_items li
       JOIN   bookings b ON b.id = li.booking_id
       WHERE  li.equipment_type_id = $1
         AND  b.status IN ('HELD','PENDING_PAYMENT','CONFIRMED')
         AND  b.start_at >= $2 AND b.start_at < $3
     ),
     peak AS (
       SELECT p.t, COALESCE(SUM(li.quantity), 0) AS units
       FROM   points p
       LEFT JOIN bookings b
         ON  b.status IN ('HELD','PENDING_PAYMENT','CONFIRMED')
         AND b.start_at <= p.t AND b.end_at > p.t
       LEFT JOIN booking_line_items li
         ON  li.booking_id = b.id AND li.equipment_type_id = $1
       GROUP BY p.t
     )
     SELECT COALESCE(MAX(units), 0)::int AS peak FROM peak`,
    [type.id, startAt, endAt],
  );

  const peak = rows[0]?.peak ?? 0;
  const effectiveCapacity = Math.floor(
    type.units_owned * (1 + Number(type.overbooking_buffer)),
  );

  if (peak + requestedQty > effectiveCapacity) {
    throw conflict(
      'EQUIPMENT_UNAVAILABLE',
      `Only ${Math.max(0, effectiveCapacity - peak)} unit(s) free for that interval.`,
    );
  }
}

async function currentPolicyVersion(tx: Tx, venueId: string): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT COALESCE(
              (SELECT current_policy_version_id FROM venues WHERE id = $1),
              (SELECT id FROM refund_policy_versions
               WHERE venue_id IS NULL ORDER BY created_at DESC LIMIT 1)
            ) AS id`,
    [venueId],
  );
  if (!rows[0]?.id) throw new Error('no refund policy version available');
  return rows[0].id;
}

function validateInterval(
  startAt: string, endAt: string, minMin: number, maxMin: number,
): void {
  const start = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();
  const now = Date.now();

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw badRequest('BAD_INTERVAL', 'end_at must be after start_at.');
  }
  if (start % 1_800_000 !== 0 || end % 1_800_000 !== 0) {
    throw badRequest('BAD_GRANULARITY', 'Bookings are in 30 minute increments.');
  }
  const minutes = (end - start) / 60_000;
  if (minutes < minMin || minutes > maxMin) {
    throw badRequest('BAD_DURATION', `Duration must be between ${minMin} and ${maxMin} minutes.`);
  }
  if (start < now + 60 * 60_000) {
    throw badRequest('TOO_SOON', 'Bookings open one hour ahead.');
  }
  if (start > now + 90 * 24 * 60 * 60_000) {
    throw badRequest('TOO_FAR', 'Bookings close 90 days ahead.');
  }
}

/**
 * Operating hours are published per weekday in the venue's local time, and
 * venues span Karachi, Dubai and London (A4). The conversion is done by
 * Postgres with AT TIME ZONE rather than in Node, so DST is the database's
 * problem and not a hand-rolled offset.
 *
 * The 15 minute turnaround may extend past closing (A5), so only start_at and
 * end_at are checked, not reserved_range.
 */
async function assertInsideOperatingHours(
  tx: Tx, venueId: string, startAt: string, endAt: string,
): Promise<void> {
  const { rows } = await tx.query<{
    dow: string; local_start: string; local_end: string; hours: unknown;
  }>(
    `SELECT lower(to_char($2::timestamptz AT TIME ZONE v.timezone, 'dy')) AS dow,
            to_char($2::timestamptz AT TIME ZONE v.timezone, 'HH24:MI')   AS local_start,
            to_char($3::timestamptz AT TIME ZONE v.timezone, 'HH24:MI')   AS local_end,
            v.operating_hours                                             AS hours
     FROM   venues v WHERE v.id = $1`,
    [venueId, startAt, endAt],
  );

  const row = rows[0];
  if (!row) throw notFound('venue not found');

  const hours = row.hours as Record<string, [string, string][]> | null;
  const windows = hours?.[row.dow] ?? [];
  const open = windows.some(([from, to]) => row.local_start >= from && row.local_end <= to);

  if (!open) {
    throw badRequest('OUTSIDE_OPERATING_HOURS',
      `The venue is not open for ${row.local_start}-${row.local_end} on ${row.dow}.`);
  }
}

function priceOf(
  room: RoomRow, types: EquipmentTypeRow[], req: HoldRequest,
): number {
  const hours = (new Date(req.endAt).getTime() - new Date(req.startAt).getTime()) / 3_600_000;
  const equipment = req.equipment.reduce((sum, line) => {
    const type = types.find((t) => t.id === line.equipmentTypeId);
    return sum + (type ? type.hourly_rate_minor * line.quantity * hours : 0);
  }, 0);
  return Math.round(room.hourly_rate_minor * hours + equipment);
}

/** A booking by id, visible only within the caller's scope. */
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

export { assertVenueWritable };

import { query } from '../db/pool.js';
import type { Tx } from '../db/pool.js';
import { type AuthScope, scopePredicate } from '../auth/scope.js';
import type { BookingRow, EquipmentLine, EquipmentLineItem } from '../domain/types.js';

const COLUMNS = `id, venue_id, room_id, user_id, status, start_at, end_at,
                 expires_at, policy_version_id, total_minor`;

export interface NewHold {
  venueId: string;
  roomId: string;
  userId: string;
  startAt: string;
  endAt: string;
  expiresAt: string;
  policyVersionId: string;
  totalMinor: number;
}

/**
 * INV-1 is settled by this statement. There is no prior SELECT for conflicts:
 * the exclusion constraint makes the check and the write one operation, and
 * rejects an overlap with 23P01.
 */
export async function insertHold(tx: Tx, hold: NewHold): Promise<BookingRow> {
  const { rows } = await tx.query<BookingRow>(
    `INSERT INTO bookings
       (venue_id, room_id, user_id, status, start_at, end_at,
        expires_at, policy_version_id, total_minor)
     VALUES ($1, $2, $3, 'HELD', $4, $5, $6, $7, $8)
     RETURNING ${COLUMNS}`,
    [hold.venueId, hold.roomId, hold.userId, hold.startAt, hold.endAt,
     hold.expiresAt, hold.policyVersionId, hold.totalMinor],
  );
  return rows[0]!;
}

export async function insertLineItem(
  tx: Tx, bookingId: string, line: EquipmentLine, hourlyRateMinor: number,
): Promise<void> {
  await tx.query(
    `INSERT INTO booking_line_items
       (booking_id, equipment_type_id, quantity, hourly_rate_minor)
     VALUES ($1, $2, $3, $4)`,
    [bookingId, line.equipmentTypeId, line.quantity, hourlyRateMinor],
  );
}

/**
 * PENDING_PAYMENT as well as HELD: a hold expiring while payment is in flight
 * is the case INV-4 is about. Nothing expires on its own — the exclusion
 * constraint's WHERE cannot reference now().
 */
export async function claimExpired(tx: Tx, limit: number): Promise<BookingRow[]> {
  const { rows } = await tx.query<BookingRow>(
    `SELECT ${COLUMNS} FROM bookings
     WHERE  status IN ('HELD', 'PENDING_PAYMENT') AND expires_at < now()
     ORDER  BY expires_at
     FOR    UPDATE SKIP LOCKED
     LIMIT  $1`,
    [limit],
  );
  return rows;
}

/** No AuthScope: both callers reach it having already established who may act. */
export async function lockById(tx: Tx, id: string): Promise<BookingRow | undefined> {
  const { rows } = await tx.query<BookingRow>(
    `SELECT ${COLUMNS} FROM bookings WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0];
}

/**
 * The only way a booking's status changes. No validation here: the BEFORE
 * UPDATE trigger checks the pair against `booking_transitions` and writes the
 * AuditEvent in the same statement.
 *
 * `WHERE status = $2` makes an already-applied transition a no-op instead of an
 * error, which is what a redelivered webhook produces. The row count separates
 * the two.
 */
export async function transition(
  tx: Tx, id: string, from: string, to: string,
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE bookings SET status = $3 WHERE id = $1 AND status = $2`,
    [id, from, to],
  );
  return (rowCount ?? 0) > 0;
}

/** `GREATEST` so re-entering checkout can only lengthen the window. */
export async function reissueHold(
  tx: Tx, id: string, minutes: number,
): Promise<Date | undefined> {
  const { rows } = await tx.query<{ expires_at: Date }>(
    `UPDATE bookings
     SET    expires_at = GREATEST(expires_at, now() + ($2 || ' minutes')::interval)
     WHERE  id = $1 AND status = 'HELD'
     RETURNING expires_at`,
    [id, String(minutes)],
  );
  return rows[0]?.expires_at;
}

/** Rates as frozen at hold, not as the equipment type charges today. */
export async function lineItems(tx: Tx, bookingId: string): Promise<EquipmentLineItem[]> {
  const { rows } = await tx.query<EquipmentLineItem>(
    `SELECT equipment_type_id, quantity, hourly_rate_minor
     FROM   booking_line_items WHERE booking_id = $1`,
    [bookingId],
  );
  return rows;
}

export interface BookingListRow extends BookingRow {
  room_name: string;
  venue_name: string;
  city: string;
}

export interface BookingFilter {
  status?: string[];
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

/**
 * A caller's bookings, newest first.
 *
 * Room and venue names are joined in because every screen that lists bookings
 * shows them, and the alternative is the caller fetching each room separately.
 *
 * `ORDER BY start_at DESC` matches `bookings_user_time_idx` for a customer and
 * `bookings_venue_time_idx` for staff.
 */
export async function list(
  scope: AuthScope, filter: BookingFilter,
): Promise<BookingListRow[]> {
  const params: unknown[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;
  const where: string[] = [];

  const pred = scopePredicate(scope, { venue: 'b.venue_id', user: 'b.user_id' }, 1);
  if (pred.params.length) { params.push(...pred.params); }
  where.push(pred.sql);

  if (filter.status?.length) where.push(`b.status = ANY(${p(filter.status)}::booking_status[])`);
  if (filter.from) where.push(`b.start_at >= ${p(filter.from)}`);
  if (filter.to) where.push(`b.start_at < ${p(filter.to)}`);

  return query<BookingListRow>(
    `SELECT b.id, b.venue_id, b.room_id, b.user_id, b.status, b.start_at, b.end_at,
            b.expires_at, b.policy_version_id, b.total_minor,
            r.name AS room_name, v.name AS venue_name, r.city
     FROM   bookings b
     JOIN   rooms  r ON r.id = b.room_id
     JOIN   venues v ON v.id = b.venue_id
     WHERE  ${where.join(' AND ')}
     ORDER  BY b.start_at DESC
     LIMIT  ${p(filter.limit)} OFFSET ${p(filter.offset)}`,
    params,
  );
}

/** INV-6: scoped in the predicate, so another venue's booking is not found rather than refused. */
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

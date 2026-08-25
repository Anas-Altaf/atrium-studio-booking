/**
 * Booking rules, as pure functions.
 *
 * Nothing here touches the database, the clock, or the request. That is the
 * point: these are the rules the brief states in its operating table, and they
 * are the part most worth testing directly. They were previously inline in the
 * repository, where reaching them meant standing up Postgres and issuing an
 * HTTP request to assert that a 90 minute booking is legal.
 *
 * `now` is a parameter rather than a call to Date.now() so a test can state the
 * instant it is reasoning about instead of arranging one.
 */
import { badRequest } from '../errors.js';
import type {
  EquipmentLine, EquipmentTypeRow, LocalWindow, RoomRow,
} from './types.js';

const HALF_HOUR_MS = 1_800_000;
const HOUR_MS = 3_600_000;
const MIN_NOTICE_MS = HOUR_MS;              // bookings open one hour ahead
const MAX_HORIZON_MS = 90 * 24 * HOUR_MS;   // and close 90 days ahead

/**
 * Two line items naming the same equipment type would each be checked against a
 * peak that does not yet include the other, and would then collide on
 * UNIQUE (booking_id, equipment_type_id). Merged before anything else looks at
 * them.
 */
export function mergeLines(lines: EquipmentLine[]): EquipmentLine[] {
  const totals = new Map<string, number>();
  for (const line of lines) {
    totals.set(line.equipmentTypeId, (totals.get(line.equipmentTypeId) ?? 0) + line.quantity);
  }
  return [...totals].map(([equipmentTypeId, quantity]) => ({ equipmentTypeId, quantity }));
}

/**
 * The operating rules from section 04 of the brief: 30 minute granularity,
 * 1 to 8 hours, from an hour ahead to 90 days ahead.
 *
 * The database enforces granularity and duration as CHECK constraints too. This
 * is not redundant — a constraint violation is a 400 with a constraint name in
 * it, and a caller deserves to be told which rule they broke.
 */
export function validateInterval(
  startAt: string,
  endAt: string,
  minMinutes: number,
  maxMinutes: number,
  now: number = Date.now(),
): void {
  const start = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw badRequest('BAD_INTERVAL', 'end_at must be after start_at.');
  }
  if (start % HALF_HOUR_MS !== 0 || end % HALF_HOUR_MS !== 0) {
    throw badRequest('BAD_GRANULARITY', 'Bookings are in 30 minute increments.');
  }

  const minutes = (end - start) / 60_000;
  if (minutes < minMinutes || minutes > maxMinutes) {
    throw badRequest('BAD_DURATION',
      `Duration must be between ${minMinutes} and ${maxMinutes} minutes.`);
  }
  if (start < now + MIN_NOTICE_MS) {
    throw badRequest('TOO_SOON', 'Bookings open one hour ahead.');
  }
  if (start > now + MAX_HORIZON_MS) {
    throw badRequest('TOO_FAR', 'Bookings close 90 days ahead.');
  }
}

/**
 * Whether a venue is open for the whole interval.
 *
 * The conversion into the venue's local time is Postgres's job — it owns the
 * timezone database and the DST rules, and the venues span Karachi, Dubai and
 * London. The comparison, once the local strings exist, is this.
 *
 * The 15 minute turnaround may run past closing (A5), so only start and end are
 * checked, not `reserved_range`.
 */
export function isOpenFor(window: LocalWindow): boolean {
  const windows = window.hours?.[window.dow] ?? [];
  return windows.some(([from, to]) => window.local_start >= from && window.local_end <= to);
}

/**
 * Units a venue will let out at once. A venue admin may enable a buffer of up
 * to 10% to absorb no-shows (brief, operating rules) — rooms are structurally
 * excluded from it (A2), which is why this takes an equipment type and there is
 * no room equivalent.
 */
export function effectiveCapacity(type: EquipmentTypeRow): number {
  return Math.floor(type.units_owned * (1 + Number(type.overbooking_buffer)));
}

/** Units still free, given the peak concurrent reservation over the interval. */
export function unitsFree(type: EquipmentTypeRow, peak: number): number {
  return Math.max(0, effectiveCapacity(type) - peak);
}

export function hoursBetween(startAt: string, endAt: string): number {
  return (new Date(endAt).getTime() - new Date(startAt).getTime()) / HOUR_MS;
}

/** Room hours plus equipment hours, in minor units. */
export function priceOf(
  room: Pick<RoomRow, 'hourly_rate_minor'>,
  types: EquipmentTypeRow[],
  lines: EquipmentLine[],
  startAt: string,
  endAt: string,
): number {
  const hours = hoursBetween(startAt, endAt);
  const equipment = lines.reduce((sum, line) => {
    const type = types.find((t) => t.id === line.equipmentTypeId);
    return sum + (type ? type.hourly_rate_minor * line.quantity * hours : 0);
  }, 0);
  return Math.round(room.hourly_rate_minor * hours + equipment);
}

export function holdExpiresAt(ttlMinutes: number, now: number = Date.now()): string {
  return new Date(now + ttlMinutes * 60_000).toISOString();
}

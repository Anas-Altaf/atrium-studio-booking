/** Booking rules. No database, no clock, no request — `now` is a parameter. */
import { badRequest } from '../errors.js';
import type {
  EquipmentLine, EquipmentTypeRow, LocalWindow, RoomRow,
} from './types.js';

const HALF_HOUR_MS = 1_800_000;
const HOUR_MS = 3_600_000;
const MIN_NOTICE_MS = HOUR_MS;
const MAX_HORIZON_MS = 90 * 24 * HOUR_MS;

/**
 * Two lines naming the same type would each be checked against a peak not yet
 * including the other, then collide on UNIQUE (booking_id, equipment_type_id).
 */
export function mergeLines(lines: EquipmentLine[]): EquipmentLine[] {
  const totals = new Map<string, number>();
  for (const line of lines) {
    totals.set(line.equipmentTypeId, (totals.get(line.equipmentTypeId) ?? 0) + line.quantity);
  }
  return [...totals].map(([equipmentTypeId, quantity]) => ({ equipmentTypeId, quantity }));
}

/**
 * Granularity and duration are CHECK constraints as well. Not redundant: a
 * constraint violation names a constraint, and a caller deserves to be told
 * which rule they broke.
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

/** The 15 minute turnaround may run past closing (A5), so only start and end are checked. */
export function isOpenFor(window: LocalWindow): boolean {
  const windows = window.hours?.[window.dow] ?? [];
  return windows.some(([from, to]) => window.local_start >= from && window.local_end <= to);
}

/** Rooms are structurally excluded from the overbooking buffer (A2). */
export function effectiveCapacity(type: EquipmentTypeRow): number {
  return Math.floor(type.units_owned * (1 + Number(type.overbooking_buffer)));
}

export function unitsFree(type: EquipmentTypeRow, peak: number): number {
  return Math.max(0, effectiveCapacity(type) - peak);
}

export function hoursBetween(startAt: string, endAt: string): number {
  return (new Date(endAt).getTime() - new Date(startAt).getTime()) / HOUR_MS;
}

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

import { badRequest, notFound } from '../errors.js';
import type { AuthScope } from '../auth/scope.js';
import type { OperatingHours, RoomSearch, RoomSearchRow } from '../domain/types.js';
import * as roomRepo from '../repositories/roomRepo.js';
import * as venueRepo from '../repositories/venueRepo.js';

export interface Availability {
  roomId: string;
  from: string;
  to: string;
  operatingHours: OperatingHours | null;
  busy: { startAt: Date; endAt: Date; status: string }[];
}

/**
 * What a room has taken over a window, and the hours it is open.
 *
 * Busy intervals rather than free ones: free depends on how long the caller
 * wants and where they are willing to start, and the turnaround is already in
 * the range. Returning what is taken keeps this one index scan.
 */
export async function availability(
  scope: AuthScope, roomId: string, from: string, to: string,
): Promise<Availability> {
  if (Date.parse(to) <= Date.parse(from)) {
    throw badRequest('BAD_INTERVAL', 'to must be after from.');
  }

  const room = await roomRepo.findVisible(scope, roomId);
  if (!room) throw notFound('room not found');

  const [busy, hours] = await Promise.all([
    roomRepo.busyIntervals(scope, roomId, from, to),
    venueRepo.operatingHours(room.venue_id),
  ]);

  return {
    roomId,
    from,
    to,
    operatingHours: hours,
    busy: busy.map((b) => ({ startAt: b.start_at, endAt: b.end_at, status: b.status })),
  };
}

export async function search(scope: AuthScope, criteria: RoomSearch): Promise<RoomSearchRow[]> {
  // The repository applies the availability filter only when both ends are
  // present, so one alone would silently return rooms that are not free.
  if (Boolean(criteria.from) !== Boolean(criteria.to)) {
    throw badRequest('INCOMPLETE_WINDOW', 'from and to must be given together, or not at all.');
  }
  // Instants, not strings: the schema accepts an offset, and two offsets sort
  // differently as text than they order in time.
  if (criteria.from && criteria.to && Date.parse(criteria.to) <= Date.parse(criteria.from)) {
    throw badRequest('BAD_INTERVAL', 'to must be after from.');
  }

  return roomRepo.search(scope, criteria);
}

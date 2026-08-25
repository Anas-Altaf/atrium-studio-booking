import { badRequest, notFound } from '../errors.js';
import type { AuthScope } from '../auth/scope.js';
import type { OperatingHours, RoomSearch, RoomSearchRow } from '../domain/types.js';
import * as equipmentRepo from '../repositories/equipmentRepo.js';
import * as roomRepo from '../repositories/roomRepo.js';
import * as venueRepo from '../repositories/venueRepo.js';

export async function findById(scope: AuthScope, roomId: string): Promise<roomRepo.RoomDetail> {
  const room = await roomRepo.findDetail(scope, roomId);
  if (!room) throw notFound('room not found');
  return room;
}

/**
 * What the room's venue rents out. Resolved through the room so the caller
 * needs only the id it already has, and so the scope check happens once.
 */
export async function equipment(
  scope: AuthScope, roomId: string,
): Promise<equipmentRepo.EquipmentOffer[]> {
  const room = await roomRepo.findVisible(scope, roomId);
  if (!room) throw notFound('room not found');
  return equipmentRepo.listForVenue(room.venue_id);
}

export interface Availability {
  roomId: string;
  from: string;
  to: string;
  operatingHours: OperatingHours | null;
  busy: { startAt: Date; endAt: Date; status: string }[];
}

/**
 * Busy intervals rather than free ones: free depends on how long the caller
 * wants and where they will start, and the turnaround is already in the range.
 * Returning what is taken keeps this one index scan.
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

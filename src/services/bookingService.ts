/**
 * The hold, as a sequence of decisions.
 *
 * The service owns the transaction. That boundary is where it belongs: the two
 * inventory guarantees are only guarantees because the checks and the writes
 * commit together, and a repository that opened its own transaction per query
 * would quietly dissolve that.
 *
 * Read top to bottom, the order below is the design:
 *
 *   INV-1  the booking INSERT is checked by the exclusion constraint. No prior
 *          SELECT for conflicts — the check and the write are one operation.
 *   INV-2  equipment types are locked FOR UPDATE, then peak concurrent usage is
 *          evaluated over the requested interval.
 *   INV-6  a venue-scoped caller reaching another venue's room gets 404.
 *
 * Lock ordering: equipment types are locked first, always sorted by id, and only
 * then is the booking inserted. A fixed global order is what stops two
 * concurrent holds over the same two types from deadlocking.
 */
import { config } from '../config.js';
import { withTransaction } from '../db/pool.js';
import type { AuthScope } from '../auth/scope.js';
import { badRequest, conflict, notFound } from '../errors.js';
import {
  effectiveCapacity, holdExpiresAt, isOpenFor, mergeLines, priceOf,
  unitsFree, validateInterval,
} from '../domain/booking.js';
import type { BookingRow, HoldRequest } from '../domain/types.js';
import * as bookingRepo from '../repositories/bookingRepo.js';
import * as equipmentRepo from '../repositories/equipmentRepo.js';
import * as roomRepo from '../repositories/roomRepo.js';
import * as venueRepo from '../repositories/venueRepo.js';

export async function createHold(scope: AuthScope, req: HoldRequest): Promise<BookingRow> {
  const equipment = mergeLines(req.equipment);

  return withTransaction({ actorId: scope.userId, reason: 'hold created' }, async (tx) => {
    // INV-6 on the write side. The scope is in the repository's predicate, so a
    // room in another venue is not found rather than found and then refused —
    // 404 either way, and the answer cannot be used to discover which room ids
    // exist (A8).
    const room = await roomRepo.findForBooking(scope, tx, req.roomId);
    if (!room) throw notFound('room not found');

    validateInterval(req.startAt, req.endAt, room.min_duration_min, room.max_duration_min);

    const window = await venueRepo.localWindow(tx, room.venue_id, req.startAt, req.endAt);
    if (!isOpenFor(window)) {
      throw badRequest('OUTSIDE_OPERATING_HOURS',
        `The venue is not open for ${window.local_start}-${window.local_end} on ${window.dow}.`);
    }

    // Sorted here as well as in the query: ORDER BY fixes the order within one
    // statement, this fixes it across the request.
    const typeIds = equipment.map((e) => e.equipmentTypeId).sort();
    const locked = typeIds.length
      ? await equipmentRepo.lockTypes(tx, typeIds, room.venue_id)
      : [];

    if (locked.length !== typeIds.length) {
      throw badRequest('UNKNOWN_EQUIPMENT', 'Equipment does not belong to this venue.');
    }

    const peaks = await equipmentRepo.peakUsage(tx, typeIds, req.startAt, req.endAt);
    for (const line of equipment) {
      const type = locked.find((t) => t.id === line.equipmentTypeId)!;
      const peak = peaks.get(type.id) ?? 0;
      if (peak + line.quantity > effectiveCapacity(type)) {
        throw conflict('EQUIPMENT_UNAVAILABLE',
          `Only ${unitsFree(type, peak)} unit(s) free for that interval.`);
      }
    }

    const policyVersionId = await venueRepo.currentPolicyVersion(tx, room.venue_id);

    const booking = await bookingRepo.insertHold(tx, {
      venueId: room.venue_id,
      roomId: req.roomId,
      userId: scope.userId,
      startAt: req.startAt,
      endAt: req.endAt,
      expiresAt: holdExpiresAt(config.holdTtlMinutes),
      policyVersionId,
      totalMinor: priceOf(room, locked, equipment, req.startAt, req.endAt),
    });

    for (const line of equipment) {
      const type = locked.find((t) => t.id === line.equipmentTypeId)!;
      await bookingRepo.insertLineItem(tx, booking.id, line, type.hourly_rate_minor);
    }

    return booking;
  });
}

export async function findById(scope: AuthScope, id: string): Promise<BookingRow> {
  const booking = await bookingRepo.findById(scope, id);
  if (!booking) throw notFound('booking not found');
  return booking;
}

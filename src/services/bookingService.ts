/**
 * The service owns the transaction: INV-1 and INV-2 are guarantees only because
 * the checks and the writes commit together.
 *
 * Equipment is locked before the booking is inserted, in id order, so two
 * concurrent holds over the same two types cannot deadlock.
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
    const room = await roomRepo.findForBooking(scope, tx, req.roomId);
    if (!room) throw notFound('room not found');

    validateInterval(req.startAt, req.endAt, room.min_duration_min, room.max_duration_min);

    const window = await venueRepo.localWindow(tx, room.venue_id, req.startAt, req.endAt);
    if (!isOpenFor(window)) {
      throw badRequest('OUTSIDE_OPERATING_HOURS',
        `The venue is not open for ${window.local_start}-${window.local_end} on ${window.dow}.`);
    }

    // Sorted here as well as in the query: ORDER BY only fixes the order within
    // one statement.
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

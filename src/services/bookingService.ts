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

/**
 * A hold expires after 8 minutes and a customer at checkout must have at least
 * 10. Reaching checkout re-issues the hold, so the shorter TTL only governs
 * holds abandoned before checkout (A1).
 *
 * Audited as HELD -> HELD, so a slot held by repeated checkouts is visible.
 */
export async function startCheckout(
  scope: AuthScope, bookingId: string,
): Promise<{ bookingId: string; expiresAt: Date; windowMinutes: number }> {
  const visible = await bookingRepo.findById(scope, bookingId);
  if (!visible) throw notFound('booking not found');

  return withTransaction({ actorId: scope.userId, reason: 'checkout re-issued the hold' }, async (tx) => {
    const booking = await bookingRepo.lockById(tx, bookingId);
    if (!booking) throw notFound('booking not found');

    if (booking.status !== 'HELD') {
      throw conflict('NOT_HELD', `Checkout starts from a held booking, not ${booking.status}.`);
    }
    // Past its TTL, the reaper either has it or is about to. Extending here
    // would race the expiry rather than prevent it.
    if (booking.expires_at && booking.expires_at.getTime() <= Date.now()) {
      throw badRequest('HOLD_EXPIRED', 'That hold has expired. Take the slot again.');
    }

    const expiresAt = await bookingRepo.reissueHold(tx, bookingId, config.checkoutWindowMinutes);
    if (!expiresAt) throw conflict('NOT_HELD', 'That booking is no longer held.');

    return { bookingId, expiresAt, windowMinutes: config.checkoutWindowMinutes };
  });
}

/**
 * What the caller may see, by their own scope: a customer their bookings, staff
 * and admins their venue's, a platform admin everything. The predicate decides,
 * so there is no role branching here.
 */
export async function list(
  scope: AuthScope, filter: bookingRepo.BookingFilter,
): Promise<bookingRepo.BookingListRow[]> {
  if (filter.from && filter.to && Date.parse(filter.to) <= Date.parse(filter.from)) {
    throw badRequest('BAD_INTERVAL', 'to must be after from.');
  }
  return bookingRepo.list(scope, filter);
}

export async function findById(scope: AuthScope, id: string): Promise<BookingRow> {
  const booking = await bookingRepo.findById(scope, id);
  if (!booking) throw notFound('booking not found');
  return booking;
}

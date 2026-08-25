/** INV-5, as a query anyone can run rather than a claim in a document. */
import { type AuthScope, isPlatformAdmin, isVenueScoped, requireVenueReach } from '../auth/scope.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { openHoursIn, utilisationPct } from '../domain/utilisation.js';
import * as reportRepo from '../repositories/reportRepo.js';
import * as venueRepo from '../repositories/venueRepo.js';

export interface Reconciliation {
  discrepancies: reportRepo.Discrepancy[];
  count: number;
  tally: reportRepo.MoneyTally;
}

export async function reconcile(scope: AuthScope): Promise<Reconciliation> {
  // A customer's venue predicate is unrestricted, which is right for the room
  // catalogue and wrong for a money report.
  if (!isPlatformAdmin(scope) && !isVenueScoped(scope)) {
    throw forbidden('reconciliation is for venue and platform administrators');
  }

  const discrepancies = await reportRepo.discrepancies(scope);
  return { discrepancies, count: discrepancies.length, tally: await reportRepo.tally(scope) };
}

/** A year is the ceiling: the denominator is stepped a day at a time. */
const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;

export interface Revenue {
  venueId: string;
  venueName: string;
  from: string;
  to: string;
  revenue: {
    grossMinor: number;
    refundedMinor: number;
    netMinor: number;
    paidBookings: number;
  };
  utilisation: {
    bookedHours: number;
    openHours: number;
    pct: number;
    rooms: number;
  };
  byRoom: reportRepo.RoomRevenue[];
}

/**
 * Per venue and per date range, as the brief asks. Scoped through
 * `requireVenueReach`, so a venue-scoped caller naming another venue's id is
 * told it does not exist rather than shown its takings.
 */
export async function revenue(
  scope: AuthScope, venueId: string, from: string, to: string,
): Promise<Revenue> {
  requireVenueReach(scope, venueId);

  const [start, end] = [Date.parse(from), Date.parse(to)];
  if (end <= start) throw badRequest('BAD_INTERVAL', 'to must be after from.');
  if (end - start > MAX_RANGE_DAYS * DAY_MS) {
    throw badRequest('RANGE_TOO_WIDE', `The range may not exceed ${MAX_RANGE_DAYS} days.`);
  }

  const venue = await venueRepo.findById(scope, venueId);
  if (!venue) throw notFound('venue not found');

  const figures = await reportRepo.venueRevenue(venueId, from, to);
  const openHours = openHoursIn(venue.operating_hours, from, to, venue.timezone)
    * figures.rooms;

  return {
    venueId,
    venueName: venue.name,
    from,
    to,
    revenue: {
      grossMinor: figures.gross_minor,
      refundedMinor: figures.refunded_minor,
      netMinor: figures.gross_minor - figures.refunded_minor,
      paidBookings: figures.paid_bookings,
    },
    utilisation: {
      bookedHours: Math.round(figures.booked_hours * 10) / 10,
      openHours,
      pct: utilisationPct(figures.booked_hours, openHours),
      rooms: figures.rooms,
    },
    byRoom: figures.by_room,
  };
}

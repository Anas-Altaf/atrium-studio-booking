import { forbidden, notFound } from '../errors.js';

export type Role = 'CUSTOMER' | 'VENUE_STAFF' | 'VENUE_ADMIN' | 'PLATFORM_ADMIN';

/** Derived from a verified token. Never built from request input. */
export interface AuthScope {
  readonly userId: string;
  readonly role: Role;
  readonly venueId: string | null;
}

export interface Predicate { sql: string; params: unknown[] }

export const isPlatformAdmin = (s: AuthScope) => s.role === 'PLATFORM_ADMIN';
export const isVenueScoped = (s: AuthScope) =>
  s.role === 'VENUE_STAFF' || s.role === 'VENUE_ADMIN';

/** Staff manage bookings; only an admin changes pricing or policy. */
export const isVenueAdmin = (s: AuthScope) => s.role === 'VENUE_ADMIN';

/**
 * For rows owned by a venue but not by a user — rooms, equipment.
 *
 * A CUSTOMER is unrestricted on purpose: the catalogue is cross-venue. What
 * scopes a customer is their own bookings, which `scopePredicate` handles.
 */
export function venuePredicate(
  scope: AuthScope, venueCol: string, nextParamIndex: number,
): Predicate {
  if (isVenueScoped(scope)) {
    return { sql: `${venueCol} = $${nextParamIndex}`, params: [scope.venueId] };
  }
  return { sql: 'TRUE', params: [] };
}

/**
 * Every write a venue console makes passes through here.
 *
 * 403 rather than 404: an admin knows their own venue exists, and refusing a
 * venue they can already name reveals nothing. The read side answers 404
 * instead, because there the id itself is what must stay unconfirmed (A8).
 */
export function requireVenueAdmin(scope: AuthScope, venueId: string): void {
  if (isPlatformAdmin(scope)) return;
  if (!isVenueAdmin(scope)) {
    throw forbidden('only a venue admin or platform admin may change a venue');
  }
  if (scope.venueId !== venueId) {
    throw forbidden('a venue admin may only change their own venue');
  }
}

/** Reads a venue's operational data: staff see it, customers do not. */
export function requireVenueReach(scope: AuthScope, venueId: string): void {
  if (isPlatformAdmin(scope)) return;
  if (!isVenueScoped(scope)) throw forbidden('this view is for venue staff');
  if (scope.venueId !== venueId) throw notFound('venue not found');
}

/** Returns SQL plus the parameter, so a caller cannot pass a value that disagrees with the clause. */
export function scopePredicate(
  scope: AuthScope,
  cols: { venue: string; user: string },
  nextParamIndex: number,
): Predicate {
  if (isPlatformAdmin(scope)) return { sql: 'TRUE', params: [] };
  if (isVenueScoped(scope)) {
    return { sql: `${cols.venue} = $${nextParamIndex}`, params: [scope.venueId] };
  }
  return { sql: `${cols.user} = $${nextParamIndex}`, params: [scope.userId] };
}

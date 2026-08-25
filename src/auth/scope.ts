export type Role = 'CUSTOMER' | 'VENUE_STAFF' | 'VENUE_ADMIN' | 'PLATFORM_ADMIN';

/**
 * Carried by every repository method as its first parameter.
 *
 * This is the whole of the tenant isolation mechanism (ARCHITECTURE.md 4A).
 * The type is what enforces it: a repository method cannot be called without a
 * scope, so the failure this invariant is actually exposed to — a forgotten
 * WHERE clause on an endpoint written late in the day — becomes a compile
 * error rather than a leak.
 *
 * Never construct one from request input. It is derived from a verified token.
 */
export interface AuthScope {
  readonly userId: string;
  readonly role: Role;
  readonly venueId: string | null;
}

export const isPlatformAdmin = (s: AuthScope) => s.role === 'PLATFORM_ADMIN';
export const isVenueScoped = (s: AuthScope) =>
  s.role === 'VENUE_STAFF' || s.role === 'VENUE_ADMIN';

export interface Predicate { sql: string; params: unknown[] }

/**
 * For tables that belong to a venue but not to a user — rooms, equipment.
 *
 *   PLATFORM_ADMIN  unrestricted
 *   VENUE_*         rows of their venue
 *   CUSTOMER        unrestricted, because booking across venues is the product
 *
 * A customer is not "unscoped" here by omission. Rooms are the catalogue; the
 * cross-venue search exists so a customer can see all of them. What a customer
 * is scoped on is their own bookings, which `scopePredicate` handles.
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
 * The predicate a repository appends, derived from the scope rather than
 * chosen by the caller.
 *
 *   PLATFORM_ADMIN  unrestricted
 *   VENUE_*         rows of their venue
 *   CUSTOMER        their own rows
 *
 * Returns SQL text plus the parameter, so callers cannot pass a value that
 * disagrees with the clause.
 */
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

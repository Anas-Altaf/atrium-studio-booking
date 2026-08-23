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
): { sql: string; params: unknown[] } {
  if (isPlatformAdmin(scope)) return { sql: 'TRUE', params: [] };
  if (isVenueScoped(scope)) {
    return { sql: `${cols.venue} = $${nextParamIndex}`, params: [scope.venueId] };
  }
  return { sql: `${cols.user} = $${nextParamIndex}`, params: [scope.userId] };
}

/**
 * Whether this scope may act on a given venue at all. Checked before any read,
 * so a request for another venue's resource never reaches SQL.
 */
export function assertVenueWritable(scope: AuthScope, venueId: string): boolean {
  if (isPlatformAdmin(scope)) return true;
  return scope.venueId === venueId;
}

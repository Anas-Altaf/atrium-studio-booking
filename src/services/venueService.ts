/**
 * Policy is data: tiers change through this endpoint with no deployment, and
 * cannot reach a booking already made, because every booking holds the version
 * in force when it was created (4B).
 */
import { withTransaction } from '../db/pool.js';
import { type AuthScope, isPlatformAdmin, isVenueAdmin } from '../auth/scope.js';
import { forbidden } from '../errors.js';
import type { RefundTier } from '../domain/types.js';
import * as venueRepo from '../repositories/venueRepo.js';

export interface PublishedPolicy {
  venueId: string;
  policyVersionId: string;
  tiers: RefundTier[];
}

export async function publishPolicy(
  scope: AuthScope, venueId: string, tiers: RefundTier[],
): Promise<PublishedPolicy> {
  // Membership and permission are separate questions: staff belong to a venue
  // but may not change its pricing or policy.
  //
  // 403 rather than 404 — an admin knows their own venue exists.
  if (!isPlatformAdmin(scope)) {
    if (!isVenueAdmin(scope)) {
      throw forbidden('only a venue admin or platform admin may publish policy');
    }
    if (scope.venueId !== venueId) {
      throw forbidden('a venue admin may only publish policy for their own venue');
    }
  }

  // So a caller cannot change the outcome by reordering the array.
  const ordered = [...tiers].sort((a, b) => b.hours_before - a.hours_before);

  return withTransaction({ actorId: scope.userId, reason: 'policy published' }, async (tx) => {
    const policyVersionId = await venueRepo.publishPolicy(tx, venueId, ordered);
    return { venueId, policyVersionId, tiers: ordered };
  });
}

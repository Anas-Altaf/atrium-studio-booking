/**
 * Publishing refund terms.
 *
 * Policy is data: an admin changes tiers through this endpoint and the change
 * is live with no deployment. It cannot reach a booking already made, because
 * every booking holds the version id in force when it was created and the
 * refund calculator reads through that (4B).
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
  // Two separate questions. Staff belong to a venue but may not change its
  // pricing or policy, so membership alone is not authorisation to write.
  //
  // 403 rather than 404: an admin knows their own venue exists, so there is
  // nothing to conceal, and a 404 would read as a broken deployment.
  if (!isPlatformAdmin(scope)) {
    if (!isVenueAdmin(scope)) {
      throw forbidden('only a venue admin or platform admin may publish policy');
    }
    if (scope.venueId !== venueId) {
      throw forbidden('a venue admin may only publish policy for their own venue');
    }
  }

  // Highest threshold first, so a caller cannot change the outcome by
  // reordering the array.
  const ordered = [...tiers].sort((a, b) => b.hours_before - a.hours_before);

  return withTransaction({ actorId: scope.userId, reason: 'policy published' }, async (tx) => {
    const policyVersionId = await venueRepo.publishPolicy(tx, venueId, ordered);
    return { venueId, policyVersionId, tiers: ordered };
  });
}

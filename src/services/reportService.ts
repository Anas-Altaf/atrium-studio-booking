/** INV-5, as a query anyone can run rather than a claim in a document. */
import { type AuthScope, isPlatformAdmin, isVenueScoped } from '../auth/scope.js';
import { forbidden } from '../errors.js';
import * as reportRepo from '../repositories/reportRepo.js';

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

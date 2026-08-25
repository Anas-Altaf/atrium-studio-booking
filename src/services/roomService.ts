/**
 * Room search.
 */
import { badRequest } from '../errors.js';
import type { AuthScope } from '../auth/scope.js';
import type { RoomSearch, RoomSearchRow } from '../domain/types.js';
import * as roomRepo from '../repositories/roomRepo.js';

export async function search(scope: AuthScope, criteria: RoomSearch): Promise<RoomSearchRow[]> {
  // The availability filter needs both ends of the window. The repository
  // applies it only when both are present, so a request carrying one silently
  // received rooms that are not free — a wrong answer returned with a 200,
  // which is worse than a refusal.
  if (Boolean(criteria.from) !== Boolean(criteria.to)) {
    throw badRequest('INCOMPLETE_WINDOW',
      'from and to must be given together, or not at all.');
  }
  // Compared as instants, not as strings. The query schema accepts an offset,
  // so "2026-06-02T01:00:00+05:00" and "2026-06-01T22:00:00Z" are two hours
  // apart in the right order while sorting the wrong way lexicographically — a
  // client sending its own local offset would have had a valid window refused.
  if (criteria.from && criteria.to
      && Date.parse(criteria.to) <= Date.parse(criteria.from)) {
    throw badRequest('BAD_INTERVAL', 'to must be after from.');
  }

  return roomRepo.search(scope, criteria);
}

import { badRequest } from '../errors.js';
import type { AuthScope } from '../auth/scope.js';
import type { RoomSearch, RoomSearchRow } from '../domain/types.js';
import * as roomRepo from '../repositories/roomRepo.js';

export async function search(scope: AuthScope, criteria: RoomSearch): Promise<RoomSearchRow[]> {
  // The repository applies the availability filter only when both ends are
  // present, so one alone would silently return rooms that are not free.
  if (Boolean(criteria.from) !== Boolean(criteria.to)) {
    throw badRequest('INCOMPLETE_WINDOW', 'from and to must be given together, or not at all.');
  }
  // Instants, not strings: the schema accepts an offset, and two offsets sort
  // differently as text than they order in time.
  if (criteria.from && criteria.to && Date.parse(criteria.to) <= Date.parse(criteria.from)) {
    throw badRequest('BAD_INTERVAL', 'to must be after from.');
  }

  return roomRepo.search(scope, criteria);
}

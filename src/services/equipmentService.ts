/**
 * Editing inventory is the one console write that can break an invariant.
 * INV-2 is enforced at hold time against `units_owned`; lowering that number
 * afterwards would leave bookings already made holding more units than exist.
 */
import { withTransaction } from '../db/pool.js';
import { type AuthScope, requireVenueAdmin } from '../auth/scope.js';
import { conflict, notFound } from '../errors.js';
import type { EquipmentAdminRow } from '../domain/types.js';
import * as equipmentRepo from '../repositories/equipmentRepo.js';

export async function update(
  scope: AuthScope, equipmentId: string, patch: equipmentRepo.EquipmentPatch,
): Promise<EquipmentAdminRow> {
  return withTransaction({ actorId: scope.userId, reason: 'equipment updated' }, async (tx) => {
    // Locked before the peak is read, so a hold committing in between is either
    // counted or blocked, never neither.
    const current = await equipmentRepo.lockOne(tx, equipmentId);
    if (!current) throw notFound('equipment not found');
    requireVenueAdmin(scope, current.venue_id);

    if (patch.unitsOwned !== undefined && patch.unitsOwned < current.units_owned) {
      const peak = await equipmentRepo.committedPeak(tx, equipmentId);
      if (patch.unitsOwned < peak) {
        throw conflict('UNITS_COMMITTED',
          `${peak} unit(s) are already committed to future bookings.`);
      }
    }

    return (await equipmentRepo.update(tx, equipmentId, patch))!;
  });
}

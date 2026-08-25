/**
 * Policy is data: tiers change through this endpoint with no deployment, and
 * cannot reach a booking already made, because every booking holds the version
 * in force when it was created (4B).
 */
import bcrypt from 'bcryptjs';
import { withTransaction } from '../db/pool.js';
import {
  type AuthScope, isPlatformAdmin, isVenueScoped,
  requireVenueAdmin, requireVenueReach,
} from '../auth/scope.js';
import { forbidden, notFound } from '../errors.js';
import type {
  EquipmentAdminRow, RefundTier, RoomAdminRow, StaffRow, VenueRow,
} from '../domain/types.js';
import * as equipmentRepo from '../repositories/equipmentRepo.js';
import * as roomRepo from '../repositories/roomRepo.js';
import * as userRepo from '../repositories/userRepo.js';
import * as venueRepo from '../repositories/venueRepo.js';

export interface PublishedPolicy {
  venueId: string;
  policyVersionId: string;
  tiers: RefundTier[];
}

export async function list(scope: AuthScope, city?: string): Promise<venueRepo.VenueListRow[]> {
  return venueRepo.list(scope, city);
}

export async function findById(scope: AuthScope, venueId: string): Promise<VenueRow> {
  const venue = await venueRepo.findById(scope, venueId);
  if (!venue) throw notFound('venue not found');
  return venue;
}

/** Only the platform creates venues: a venue admin is scoped to one that exists. */
export async function create(scope: AuthScope, input: venueRepo.NewVenue): Promise<VenueRow> {
  if (!isPlatformAdmin(scope)) throw forbidden('only a platform admin may create a venue');

  return withTransaction({ actorId: scope.userId, reason: 'venue created' }, async (tx) =>
    venueRepo.insert(tx, input));
}

export async function update(
  scope: AuthScope, venueId: string, patch: venueRepo.VenuePatch,
): Promise<VenueRow> {
  requireVenueAdmin(scope, venueId);

  const venue = await withTransaction(
    { actorId: scope.userId, reason: 'venue updated' },
    async (tx) => venueRepo.update(tx, venueId, patch),
  );
  if (!venue) throw notFound('venue not found');
  return venue;
}

/** The console's room table. Archived rooms included — it is where they come back from. */
export async function rooms(scope: AuthScope, venueId: string): Promise<RoomAdminRow[]> {
  requireVenueReach(scope, venueId);
  return roomRepo.listForVenue(venueId);
}

export async function addRoom(
  scope: AuthScope, venueId: string, input: Omit<roomRepo.NewRoom, 'venueId'>,
): Promise<RoomAdminRow> {
  requireVenueAdmin(scope, venueId);
  await findById(scope, venueId);

  return withTransaction({ actorId: scope.userId, reason: 'room created' }, async (tx) =>
    roomRepo.insert(tx, { ...input, venueId }));
}

export async function equipment(
  scope: AuthScope, venueId: string,
): Promise<EquipmentAdminRow[]> {
  requireVenueReach(scope, venueId);
  return equipmentRepo.listForVenueAdmin(venueId);
}

export async function addEquipment(
  scope: AuthScope, venueId: string, input: Omit<equipmentRepo.NewEquipment, 'venueId'>,
): Promise<EquipmentAdminRow> {
  requireVenueAdmin(scope, venueId);
  await findById(scope, venueId);

  return withTransaction({ actorId: scope.userId, reason: 'equipment created' }, async (tx) =>
    equipmentRepo.insert(tx, { ...input, venueId }));
}

export async function staff(scope: AuthScope, venueId: string): Promise<StaffRow[]> {
  requireVenueAdmin(scope, venueId);
  return venueRepo.staff(venueId);
}

const VENUE_ROLES = new Set(['VENUE_STAFF', 'VENUE_ADMIN']);

/**
 * A venue admin may only mint accounts inside their own venue, and only venue
 * roles. Minting a PLATFORM_ADMIN here would be an escalation from a scoped
 * account to an unscoped one, which is INV-6 defeated in one call.
 */
export async function addStaff(
  scope: AuthScope, venueId: string, input: { email: string; password: string; role: string },
): Promise<StaffRow> {
  requireVenueAdmin(scope, venueId);
  if (!VENUE_ROLES.has(input.role)) throw forbidden('a venue account is staff or admin');
  await findById(scope, venueId);

  const passwordHash = await bcrypt.hash(input.password, 10);

  return withTransaction({ actorId: scope.userId, reason: 'staff created' }, async (tx) =>
    userRepo.insert(tx, { email: input.email, passwordHash, role: input.role, venueId }));
}

export async function updateStaff(
  scope: AuthScope, venueId: string, userId: string, patch: userRepo.StaffPatch,
): Promise<StaffRow> {
  requireVenueAdmin(scope, venueId);
  if (patch.role !== undefined && !VENUE_ROLES.has(patch.role)) {
    throw forbidden('a venue account is staff or admin');
  }
  // Locking oneself out is a support ticket, not a feature.
  if (userId === scope.userId && patch.active === false) {
    throw forbidden('an admin cannot deactivate their own account');
  }

  const updated = await withTransaction(
    { actorId: scope.userId, reason: 'staff updated' },
    async (tx) => userRepo.updateStaff(tx, venueId, userId, patch),
  );
  if (!updated) throw notFound('staff member not found');
  return updated;
}

/**
 * The terms a venue publishes today.
 *
 * A customer reads these before booking, so they are not confined the way a
 * venue's operational data is — but a venue-scoped caller stays inside their
 * own venue, because INV-6 does not bend for a convenience read.
 */
export async function currentPolicy(
  scope: AuthScope, venueId: string,
): Promise<venueRepo.PublishedPolicy> {
  if (isVenueScoped(scope) && scope.venueId !== venueId) throw notFound('venue not found');

  const policy = await venueRepo.currentPolicy(venueId);
  if (!policy) throw notFound('venue not found');
  return policy;
}

export async function publishPolicy(
  scope: AuthScope, venueId: string, tiers: RefundTier[],
): Promise<PublishedPolicy> {
  // Membership and permission are separate questions: staff belong to a venue
  // but may not change its pricing or policy.
  requireVenueAdmin(scope, venueId);

  // So a caller cannot change the outcome by reordering the array.
  const ordered = [...tiers].sort((a, b) => b.hours_before - a.hours_before);

  return withTransaction({ actorId: scope.userId, reason: 'policy published' }, async (tx) => {
    const policyVersionId = await venueRepo.publishPolicy(tx, venueId, ordered);
    return { venueId, policyVersionId, tiers: ordered };
  });
}

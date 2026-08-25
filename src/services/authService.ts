import bcrypt from 'bcryptjs';
import { withTransaction } from '../db/pool.js';
import type { AuthScope } from '../auth/scope.js';
import { unauthorized } from '../errors.js';
import * as userRepo from '../repositories/userRepo.js';
import * as venueRepo from '../repositories/venueRepo.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: string;
  venueId: string | null;
}

/**
 * Compared against when the account does not exist, so a missing account and a
 * wrong password take the same time. Without it the difference is a bcrypt
 * comparison, which is enough to enumerate accounts.
 */
const ABSENT_USER_HASH = '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv';

export async function verifyCredentials(
  email: string, password: string,
): Promise<AuthenticatedUser> {
  const user = await userRepo.findByEmail(email);
  const ok = await bcrypt.compare(password, user?.password_hash ?? ABSENT_USER_HASH);

  // A deactivated account fails the same way a wrong password does: telling a
  // caller their account exists but is switched off is still enumeration.
  if (!user || !ok || !user.active) throw unauthorized('invalid email or password');

  return { id: user.id, email: user.email, role: user.role, venueId: user.venue_id };
}

/**
 * Self-service is for customers only. Every other role is scoped to a venue,
 * and a caller choosing their own venue is INV-6 handed to the caller — venue
 * accounts are minted by an admin of that venue.
 */
export async function register(email: string, password: string): Promise<AuthenticatedUser> {
  const passwordHash = await bcrypt.hash(password, 10);

  const created = await withTransaction({ actorId: null, reason: 'registered' }, async (tx) =>
    userRepo.insert(tx, { email, passwordHash, role: 'CUSTOMER', venueId: null }));

  return { id: created.id, email: created.email, role: created.role, venueId: created.venue_id };
}

export async function changePassword(
  scope: AuthScope, currentPassword: string, newPassword: string,
): Promise<void> {
  const user = await userRepo.findById(scope.userId);
  if (!user || !await bcrypt.compare(currentPassword, user.password_hash)) {
    throw unauthorized('current password does not match');
  }
  await userRepo.updatePassword(user.id, await bcrypt.hash(newPassword, 10));
}

export interface Profile extends AuthScope {
  email: string;
  venueName: string | null;
}

/** What a client needs to draw its own navigation: who, which role, which venue. */
export async function profile(scope: AuthScope): Promise<Profile> {
  const user = await userRepo.findById(scope.userId);
  if (!user) throw unauthorized('account no longer exists');

  return {
    ...scope,
    email: user.email,
    venueName: scope.venueId ? await venueRepo.nameOf(scope.venueId) : null,
  };
}

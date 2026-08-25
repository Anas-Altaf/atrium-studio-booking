import bcrypt from 'bcryptjs';
import { unauthorized } from '../errors.js';
import * as userRepo from '../repositories/userRepo.js';

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

  if (!user || !ok) throw unauthorized('invalid email or password');

  return { id: user.id, email: user.email, role: user.role, venueId: user.venue_id };
}

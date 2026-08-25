/**
 * Credential checking.
 *
 * Signing the token is not here. The JWT is issued by the Fastify plugin and is
 * a transport concern; what this service owns is the question "are these
 * credentials good", which is answerable without knowing there is an HTTP layer
 * at all.
 */
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
 * A bcrypt hash of nothing, compared against when the account does not exist.
 *
 * Without it, a missing account returns in the time of a database lookup and a
 * wrong password returns in the time of a bcrypt comparison — roughly a hundred
 * milliseconds apart, which is enough to enumerate who has an account.
 */
const ABSENT_USER_HASH =
  '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv';

export async function verifyCredentials(
  email: string, password: string,
): Promise<AuthenticatedUser> {
  const user = await userRepo.findByEmail(email);
  const ok = await bcrypt.compare(password, user?.password_hash ?? ABSENT_USER_HASH);

  if (!user || !ok) throw unauthorized('invalid email or password');

  return { id: user.id, email: user.email, role: user.role, venueId: user.venue_id };
}

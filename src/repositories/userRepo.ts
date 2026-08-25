/**
 * User reads.
 *
 * This existed as a SELECT inside the login route handler, which CLAUDE.md
 * forbids and which meant the one query authenticating every request lived
 * outside the layer where queries are reviewed.
 *
 * No AuthScope parameter here, unlike every other repository: this runs before
 * a caller has an identity. It is the one lookup that cannot be scoped, and it
 * returns a password hash, so it is deliberately the only function in the file.
 */
import { query } from '../db/pool.js';
import type { UserRow } from '../domain/types.js';

export async function findByEmail(email: string): Promise<UserRow | undefined> {
  const rows = await query<UserRow>(
    'SELECT id, email, password_hash, role, venue_id FROM users WHERE email = $1',
    [email],
  );
  return rows[0];
}

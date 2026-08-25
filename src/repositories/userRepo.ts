import { query } from '../db/pool.js';
import type { UserRow } from '../domain/types.js';

/** No AuthScope: this runs before the caller has an identity. */
export async function findByEmail(email: string): Promise<UserRow | undefined> {
  const rows = await query<UserRow>(
    'SELECT id, email, password_hash, role, venue_id FROM users WHERE email = $1',
    [email],
  );
  return rows[0];
}

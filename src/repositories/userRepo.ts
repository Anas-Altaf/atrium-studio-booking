import { query } from '../db/pool.js';
import type { Tx } from '../db/pool.js';
import type { StaffRow, UserRow } from '../domain/types.js';

/** No AuthScope: this runs before the caller has an identity. */
export async function findByEmail(email: string): Promise<UserRow | undefined> {
  const rows = await query<UserRow>(
    'SELECT id, email, password_hash, role, venue_id, active FROM users WHERE email = $1',
    [email],
  );
  return rows[0];
}

export async function findById(id: string): Promise<UserRow | undefined> {
  const rows = await query<UserRow>(
    'SELECT id, email, password_hash, role, venue_id, active FROM users WHERE id = $1',
    [id],
  );
  return rows[0];
}

export interface NewUser {
  email: string;
  passwordHash: string;
  role: string;
  venueId: string | null;
}

/**
 * `role_venue_agreement` (002) refuses a venue-scoped role without a venue and
 * a platform admin with one, so a caller cannot invent a shape that scopes to
 * nothing and reads everything. 23505 on the email becomes a 409 upstream.
 */
export async function insert(tx: Tx, u: NewUser): Promise<StaffRow> {
  const { rows } = await tx.query<StaffRow>(
    `INSERT INTO users (email, password_hash, role, venue_id)
     VALUES ($1, $2, $3::user_role, $4)
     RETURNING id, email, role, venue_id, active, created_at`,
    [u.email, u.passwordHash, u.role, u.venueId],
  );
  return rows[0]!;
}

export interface StaffPatch {
  role?: string;
  active?: boolean;
}

/** Scoped by the caller having already been checked against `venueId`. */
export async function updateStaff(
  tx: Tx, venueId: string, userId: string, patch: StaffPatch,
): Promise<StaffRow | undefined> {
  const sets: string[] = [];
  const params: unknown[] = [userId, venueId];
  const p = (v: unknown) => `$${params.push(v)}`;

  if (patch.role !== undefined) sets.push(`role = ${p(patch.role)}::user_role`);
  if (patch.active !== undefined) sets.push(`active = ${p(patch.active)}`);

  const { rows } = await tx.query<StaffRow>(
    sets.length
      ? `UPDATE users SET ${sets.join(', ')} WHERE id = $1 AND venue_id = $2
         RETURNING id, email, role, venue_id, active, created_at`
      : `SELECT id, email, role, venue_id, active, created_at
         FROM users WHERE id = $1 AND venue_id = $2`,
    params,
  );
  return rows[0];
}

export async function updatePassword(id: string, passwordHash: string): Promise<void> {
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [id, passwordHash]);
}

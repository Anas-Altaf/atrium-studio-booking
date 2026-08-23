import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { unauthorized } from '../errors.js';

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

interface UserRow {
  id: string; email: string; password_hash: string;
  role: string; venue_id: string | null;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (req) => {
    const body = credentials.parse(req.body);

    const rows = await query<UserRow>(
      'SELECT id, email, password_hash, role, venue_id FROM users WHERE email = $1',
      [body.email],
    );
    const user = rows[0];

    // Compare against a dummy hash when the user is absent so a missing account
    // and a wrong password take the same time to answer.
    const hash = user?.password_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
    const ok = await bcrypt.compare(body.password, hash);
    if (!user || !ok) throw unauthorized('invalid email or password');

    const token = app.jwt.sign(
      { sub: user.id, role: user.role, venueId: user.venue_id },
      { expiresIn: '12h' },
    );
    return { token, user: { id: user.id, email: user.email, role: user.role, venueId: user.venue_id } };
  });

  app.get('/auth/me', { onRequest: [app.authenticate] }, async (req) => req.scope);
}

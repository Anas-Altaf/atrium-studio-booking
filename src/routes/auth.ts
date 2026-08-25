import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as authService from '../services/authService.js';

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (req) => {
    const body = credentials.parse(req.body);
    const user = await authService.verifyCredentials(body.email, body.password);

    const token = app.jwt.sign(
      { sub: user.id, role: user.role, venueId: user.venueId },
      { expiresIn: '12h' },
    );
    return { token, user };
  });

  app.get('/auth/me', { onRequest: [app.authenticate] }, async (req) => req.scope);
}

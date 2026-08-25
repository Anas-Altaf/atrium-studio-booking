import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as authService from '../services/authService.js';

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const signup = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const passwordChange = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (req) => {
    const body = credentials.parse(req.body);
    const user = await authService.verifyCredentials(body.email, body.password);
    return { token: issue(app, user), user };
  });

  /** Customers only — every other role is minted by an admin of its venue. */
  app.post('/auth/register', async (req, reply) => {
    const body = signup.parse(req.body);
    const user = await authService.register(body.email, body.password);
    return reply.code(201).send({ token: issue(app, user), user });
  });

  app.get('/auth/me', { onRequest: [app.authenticate] },
    async (req) => authService.profile(req.scope));

  app.patch('/auth/password', { onRequest: [app.authenticate] }, async (req) => {
    const body = passwordChange.parse(req.body);
    await authService.changePassword(req.scope, body.currentPassword, body.newPassword);
    return { changed: true };
  });
}

const issue = (app: FastifyInstance, user: authService.AuthenticatedUser) =>
  app.jwt.sign({ sub: user.id, role: user.role, venueId: user.venueId }, { expiresIn: '12h' });

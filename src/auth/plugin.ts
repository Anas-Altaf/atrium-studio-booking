import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import jwt from '@fastify/jwt';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import type { AuthScope, Role } from './scope.js';
import { unauthorized } from '../errors.js';

declare module 'fastify' {
  interface FastifyRequest { scope: AuthScope }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

interface TokenPayload { sub: string; role: Role; venueId: string | null }

/**
 * `fp` deliberately: a decorator added inside a plain register() lives in that
 * plugin's context and would not exist where the routes are registered.
 */
export const authPlugin = fp(async function authPlugin(app: FastifyInstance): Promise<void> {
  await app.register(jwt, { secret: config.jwtSecret });

  app.decorateRequest('scope', null);

  // Built from the verified token and nothing else, so a caller cannot widen
  // their own scope through the body or query string.
  app.decorate('authenticate', async (req: FastifyRequest) => {
    let payload: TokenPayload;
    try {
      payload = await req.jwtVerify<TokenPayload>();
    } catch {
      throw unauthorized('a valid bearer token is required');
    }
    req.scope = {
      userId: payload.sub,
      role: payload.role,
      venueId: payload.venueId ?? null,
    };
  });
});

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
 * Wrapped with fastify-plugin deliberately. A decorator added inside a normal
 * app.register() lives in that plugin's encapsulation context and is invisible
 * to sibling plugins, so app.authenticate would not exist where the routes are
 * registered. fastify-plugin breaks the encapsulation so it attaches to the
 * root instance.
 */
export const authPlugin = fp(async function authPlugin(app: FastifyInstance): Promise<void> {
  await app.register(jwt, { secret: config.jwtSecret });

  app.decorateRequest('scope', null);

  /**
   * Builds the AuthScope from the verified token, and only from the verified
   * token. Nothing in the request body or query string reaches it, so a caller
   * cannot widen their own scope.
   */
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

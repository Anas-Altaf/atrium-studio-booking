import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

/**
 * A correlation id per request, echoed on the response and carried into the
 * webhook path so a charge can be traced from the hold that created it.
 * Accepts an inbound x-correlation-id so the load balancer or a caller can
 * supply one.
 */
export async function correlationPlugin(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    const incoming = req.headers['x-correlation-id'];
    const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
    req.id = id;
    reply.header('x-correlation-id', id);
    reply.header('x-served-by', config.instanceId);
  });
}

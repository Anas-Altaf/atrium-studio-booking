import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';

/**
 * A correlation id per request, echoed on the response and carried into the
 * webhook path so a charge can be traced from the hold that created it.
 * Accepts an inbound x-correlation-id so the load balancer or a caller can
 * supply one.
 */
export const correlationPlugin = fp(async function correlationPlugin(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-correlation-id', req.id);
    // Which replica answered. The concurrency proof asserts on this: a proof
    // that only ever reached one process proves nothing.
    reply.header('x-served-by', config.instanceId);
  });
});

import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';

export const correlationPlugin = fp(async function correlationPlugin(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-correlation-id', req.id);
    // The concurrency proof asserts on this: a proof that only ever reached one
    // process proves nothing.
    reply.header('x-served-by', config.instanceId);
  });
});

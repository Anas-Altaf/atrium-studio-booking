import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { AppError } from './errors.js';
import { authPlugin } from './auth/plugin.js';
import { correlationPlugin } from './lib/correlation.js';
import * as healthService from './services/healthService.js';
import { authRoutes } from './routes/auth.js';
import { bookingRoutes } from './routes/bookings.js';
import { roomRoutes } from './routes/rooms.js';
import { paymentRoutes } from './routes/payments.js';
import { startWorker } from './worker/index.js';

/** Bounded and printable. Anything else is replaced with a generated id. */
const CORRELATION_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export async function build() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      base: { instance: config.instanceId },
    },
    // Fastify honours a `request-id` header and skips genReqId entirely, which
    // would let a caller choose our correlation id.
    requestIdHeader: false,
    // The correlation id is the request id, so every log line carries it.
    genReqId: (req) => {
      const h = req.headers['x-correlation-id'];
      return typeof h === 'string' && CORRELATION_ID.test(h) ? h : randomUUID();
    },
  });

  // Before every register(), not after: a plugin captures the error handler in
  // force when its context is created, so one set afterwards reaches no route.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({
        error: err.code, message: err.message, correlationId: req.id,
      });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'VALIDATION_FAILED', issues: err.issues, correlationId: req.id,
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'INTERNAL', correlationId: req.id });
  });

  // Before the routes, so the preflight is answered for all of them. Bearer
  // tokens rather than cookies, so credentials stays off.
  await app.register(cors, {
    origin: config.corsOrigins.length ? config.corsOrigins : false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-correlation-id'],
    credentials: false,
  });

  await app.register(correlationPlugin);
  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(bookingRoutes);
  await app.register(roomRoutes);
  await app.register(paymentRoutes);

  app.get('/health', async (_req, reply) => {
    const report = await healthService.check();
    return report.status === 'ok' ? report : reply.code(503).send(report);
  });

  return app;
}

const isEntry = process.argv[1]?.includes('server');

if (isEntry) {
  const app = await build();
  try {
    if (process.env.RUN_MIGRATIONS !== 'false') await migrate();

    // Only when this file is the entry point: `build()` is also what the tests
    // call, and a loop polling underneath them would apply the very events a
    // test is about to assert are unapplied.
    if (config.workerEnabled) {
      const worker = startWorker(app.log);
      app.addHook('onClose', async () => { worker.stop(); });
    }

    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

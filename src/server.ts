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

/** Bounded and printable. Anything else is replaced with a generated id. */
const CORRELATION_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export async function build() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      base: { instance: config.instanceId },
    },
    // Fastify reads a `request-id` header by default and, when it finds one,
    // returns it verbatim without ever calling genReqId. Any caller could
    // therefore choose our correlation id -- including choosing one already in
    // use, which makes two unrelated requests indistinguishable in the logs.
    // Turning the default off is what makes genReqId below authoritative; the
    // one header we do accept is validated there.
    requestIdHeader: false,
    // The correlation id is the request id, so it appears on every log line
    // this request produces without threading it through by hand.
    genReqId: (req) => {
      const h = req.headers['x-correlation-id'];
      // An inbound id is echoed back in a response header and written to every
      // log line, so it is accepted only in a bounded, printable form. A value
      // carrying a newline would either forge a log record or make Node throw
      // on the response header, which would surface as a 500 on a request that
      // was otherwise fine.
      return typeof h === 'string' && CORRELATION_ID.test(h) ? h : randomUUID();
    },
  });

  // Before every register() call, not after. A plugin registered with
  // app.register() gets its own encapsulation context and captures the error
  // handler in force at that moment, so a handler set afterwards never reaches
  // any route. Deploying found this: a Zod failure came back as a 500 carrying
  // the raw validation detail instead of a 400. Same encapsulation trap as the
  // auth decorator in AI_LOG 14.
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

  // Before the routes, so the preflight is answered for every one of them. The
  // frontend is on a different origin, so without this every browser call fails
  // while curl succeeds -- the failure mode that looks like a broken API.
  // Bearer tokens, not cookies, so credentials stays off and no origin is
  // trusted with the session.
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
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

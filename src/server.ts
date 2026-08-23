import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { AppError } from './errors.js';
import { authPlugin } from './auth/plugin.js';
import { correlationPlugin } from './lib/logger.js';
import { authRoutes } from './routes/auth.js';
import { bookingRoutes } from './routes/bookings.js';
import { roomRoutes } from './routes/rooms.js';

export async function build() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      base: { instance: config.instanceId },
    },
    // The correlation id is the request id, so it appears on every log line
    // this request produces without threading it through by hand.
    genReqId: (req) => {
      const h = req.headers['x-correlation-id'];
      return typeof h === 'string' && h.length > 0 ? h : randomUUID();
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

  /**
   * A health check that means something: it asks the database a question
   * rather than reporting that the process is running.
   */
  app.get('/health', async (_req, reply) => {
    try {
      const { rows } = await pool.query('SELECT 1 AS ok');
      const migrations = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM schema_migrations',
      );
      return {
        status: 'ok',
        instance: config.instanceId,
        database: rows[0]?.ok === 1 ? 'reachable' : 'unexpected',
        migrationsApplied: Number(migrations.rows[0]?.count ?? 0),
      };
    } catch (err) {
      return reply.code(503).send({
        status: 'degraded',
        instance: config.instanceId,
        database: 'unreachable',
        error: (err as Error).message,
      });
    }
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

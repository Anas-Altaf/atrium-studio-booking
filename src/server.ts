import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { AppError } from './errors.js';
import { authPlugin } from './auth/plugin.js';
import { correlationPlugin } from './lib/logger.js';
import { authRoutes } from './routes/auth.js';
import { bookingRoutes } from './routes/bookings.js';

export async function build() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      base: { instance: config.instanceId },
    },
    genReqId: () => '',
  });

  await app.register(correlationPlugin);
  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(bookingRoutes);

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

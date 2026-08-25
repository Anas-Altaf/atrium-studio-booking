export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5432/atrium',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-do-not-use-in-production',
  holdTtlMinutes: 8,
  instanceId: process.env.INSTANCE_ID ?? 'api-local',

  paygateUrl: process.env.PAYGATE_URL ?? 'http://localhost:4000',
  paygateSecret: process.env.PAYGATE_SECRET ?? 'paygate-dev-secret',

  workerEnabled: process.env.WORKER_ENABLED !== 'false',
  workerIntervalMs: Number(process.env.WORKER_INTERVAL_MS ?? 1_000),
  workerBatchSize: Number(process.env.WORKER_BATCH_SIZE ?? 20),

  /** Empty means same-origin only: a forgotten variable fails closed. */
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',').map((o) => o.trim()).filter(Boolean),
} as const;

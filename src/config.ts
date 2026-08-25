const port = Number(process.env.PORT ?? 3000);

/**
 * Mounts the mock provider inside this process. On the free tier a second
 * service sleeps on its own schedule, so a reviewer returning after twenty
 * minutes would find a provider that never calls back. Under compose it stays
 * a separate service, which is the shape the brief describes.
 */
const paygateEmbedded = process.env.PAYGATE_EMBEDDED === 'on';

export const config = {
  port,
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5432/atrium',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-do-not-use-in-production',
  holdTtlMinutes: 8,
  // The brief gives a hold 8 minutes and a customer at checkout at least 10.
  // Reaching checkout re-issues the hold, so the shorter TTL only ever governs
  // holds that were abandoned before checkout (A1).
  checkoutWindowMinutes: 10,
  instanceId: process.env.INSTANCE_ID ?? 'api-local',

  paygateEmbedded,
  paygateChaos: process.env.PAYGATE_CHAOS === 'on',
  paygateSecret: process.env.PAYGATE_SECRET ?? 'paygate-dev-secret',
  // Embedded, the loop never leaves the container: the worker calls this
  // process and the callback comes back to it. No public hostname needed.
  paygateUrl: process.env.PAYGATE_URL
    ?? (paygateEmbedded ? `http://127.0.0.1:${port}` : 'http://localhost:4000'),
  paygateCallbackUrl: process.env.PAYGATE_CALLBACK_URL
    ?? `http://127.0.0.1:${port}/webhooks/paygate`,

  workerEnabled: process.env.WORKER_ENABLED !== 'false',
  workerIntervalMs: Number(process.env.WORKER_INTERVAL_MS ?? 1_000),
  workerBatchSize: Number(process.env.WORKER_BATCH_SIZE ?? 20),

  /** Empty means same-origin only: a forgotten variable fails closed. */
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',').map((o) => o.trim()).filter(Boolean),
} as const;

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5432/atrium',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-do-not-use-in-production',
  paygateUrl: process.env.PAYGATE_URL ?? 'http://localhost:4000',
  paygateSecret: process.env.PAYGATE_SECRET ?? 'paygate-dev-secret',
  holdTtlMinutes: 8,
  checkoutWindowMinutes: 10,
  instanceId: process.env.INSTANCE_ID ?? 'api-local',
  workerEnabled: process.env.WORKER_ENABLED !== 'false',
} as const;

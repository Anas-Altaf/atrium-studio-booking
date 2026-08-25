/**
 * Only what the code actually reads.
 *
 * `paygateUrl`, `paygateSecret`, `workerEnabled` and `checkoutWindowMinutes`
 * were here before anything read them. Configuration for a feature that does
 * not exist reads as a feature that does — `checkoutWindowMinutes: 10` in
 * particular claimed the brief's checkout window was implemented. Each goes
 * back in with the code that reads it.
 */
export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5432/atrium',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-do-not-use-in-production',
  holdTtlMinutes: 8,
  instanceId: process.env.INSTANCE_ID ?? 'api-local',
  // Comma separated. Empty means same-origin only, which is the local default:
  // docker compose serves nothing cross-origin.
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',').map((o) => o.trim()).filter(Boolean),
} as const;

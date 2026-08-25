/**
 * A health check that means something: it asks the database a question rather
 * than reporting that the process is running.
 *
 * Reporting the migration count as well as reachability catches the case a bare
 * ping does not — a replica connected to a database that never ran its
 * migrations answers every request with a 500 while looking healthy.
 */
import { config } from '../config.js';
import * as systemRepo from '../repositories/systemRepo.js';

export interface HealthReport {
  status: 'ok' | 'degraded';
  instance: string;
  database: 'reachable' | 'unexpected' | 'unreachable';
  migrationsApplied?: number;
  error?: string;
}

export async function check(): Promise<HealthReport> {
  try {
    const reachable = await systemRepo.ping();
    return {
      status: 'ok',
      instance: config.instanceId,
      database: reachable ? 'reachable' : 'unexpected',
      migrationsApplied: await systemRepo.migrationsApplied(),
    };
  } catch (err) {
    return {
      status: 'degraded',
      instance: config.instanceId,
      database: 'unreachable',
      error: (err as Error).message,
    };
  }
}

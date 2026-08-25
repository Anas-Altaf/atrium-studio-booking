/**
 * The migration count, not just reachability: a replica pointed at an
 * unmigrated database answers every request with a 500 while looking healthy.
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

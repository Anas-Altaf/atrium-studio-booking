/**
 * In the API process, not a separate service. A second container on the free
 * tier sleeps on its own schedule, and SKIP LOCKED already makes three
 * concurrent workers safe (4D).
 */
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { processWebhooks, submitPendingCharges } from './jobs.js';

export interface Worker { stop: () => void }

export function startWorker(log: FastifyBaseLogger): Worker {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    try {
      const submitted = await submitPendingCharges(log);
      const applied = await processWebhooks(log);
      if (submitted || applied) log.info({ submitted, applied }, 'worker tick');
    } catch (err) {
      // A failing tick must not take the loop with it.
      log.warn({ err: (err as Error).message }, 'worker tick failed');
    }

    if (!stopped) timer = setTimeout(() => { void tick(); }, config.workerIntervalMs);
  };

  log.info({ intervalMs: config.workerIntervalMs }, 'worker started');
  timer = setTimeout(() => { void tick(); }, config.workerIntervalMs);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

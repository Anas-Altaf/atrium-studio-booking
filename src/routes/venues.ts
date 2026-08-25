import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as venueService from '../services/venueService.js';

const tier = z.object({
  hours_before: z.number().int().nonnegative(),
  room_pct: z.number().int().min(0).max(100),
  equipment_pct: z.number().int().min(0).max(100),
});

const policyBody = z.object({
  // A policy with no band covering the last hours before start would refund
  // nothing there by accident rather than by decision.
  tiers: z.array(tier).min(1).refine(
    (ts) => ts.some((t) => t.hours_before === 0),
    { message: 'tiers must include a band at hours_before 0' },
  ),
});

export async function venueRoutes(app: FastifyInstance): Promise<void> {
  app.patch<{ Params: { id: string } }>(
    '/venues/:id/policy',
    { onRequest: [app.authenticate] },
    async (req) => {
      const body = policyBody.parse(req.body);
      return venueService.publishPolicy(req.scope, req.params.id, body.tiers);
    },
  );
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as reportService from '../services/reportService.js';

const revenueQuery = z.object({
  venueId: z.string().uuid(),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
});

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  /** INV-5. Zero discrepancies on demand is the requirement. */
  app.get('/reports/reconciliation', { onRequest: [app.authenticate] },
    async (req) => reportService.reconcile(req.scope));

  /** Per venue and per range, as the brief asks. `venueId` is required so the
   *  answer is always one venue's books rather than a silent aggregate. */
  app.get('/reports/revenue', { onRequest: [app.authenticate] }, async (req) => {
    const { venueId, from, to } = revenueQuery.parse(req.query);
    return reportService.revenue(req.scope, venueId, from, to);
  });
}

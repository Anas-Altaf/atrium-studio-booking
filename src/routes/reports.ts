import type { FastifyInstance } from 'fastify';
import * as reportService from '../services/reportService.js';

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  /** INV-5. Zero discrepancies on demand is the requirement. */
  app.get('/reports/reconciliation', { onRequest: [app.authenticate] },
    async (req) => reportService.reconcile(req.scope));
}

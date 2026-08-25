import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as equipmentService from '../services/equipmentService.js';

const equipmentPatch = z.object({
  name: z.string().min(1).max(200).optional(),
  hourlyRateMinor: z.number().int().nonnegative().optional(),
  unitsOwned: z.number().int().positive().max(100_000).optional(),
  // The brief caps the buffer at 10%.
  overbookingBuffer: z.number().min(0).max(0.1).optional(),
  active: z.boolean().optional(),
});

export async function equipmentRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Creating equipment is `POST /venues/:id/equipment` — it needs the venue.
   * Editing does not: the row already names its venue, and that is what the
   * caller's scope is checked against.
   */
  app.patch<{ Params: { id: string } }>(
    '/equipment/:id',
    { onRequest: [app.authenticate] },
    async (req) => equipmentService.update(req.scope, req.params.id, equipmentPatch.parse(req.body)),
  );
}

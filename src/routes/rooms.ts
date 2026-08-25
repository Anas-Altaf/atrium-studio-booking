import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as roomService from '../services/roomService.js';

const csv = z.string().transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

const searchQuery = z.object({
  city: z.string().min(1).optional(),
  minCapacity: z.coerce.number().int().positive().optional(),
  maxPriceMinor: z.coerce.number().int().nonnegative().optional(),
  amenities: csv.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

const window = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
});

export async function roomRoutes(app: FastifyInstance): Promise<void> {
  app.get('/rooms', { onRequest: [app.authenticate] }, async (req) => {
    const criteria = searchQuery.parse(req.query);
    return roomService.search(req.scope, criteria);
  });

  app.get<{ Params: { id: string } }>(
    '/rooms/:id',
    { onRequest: [app.authenticate] },
    async (req) => roomService.findById(req.scope, req.params.id),
  );

  /** The equipment the room's venue rents out, for building a hold. */
  app.get<{ Params: { id: string } }>(
    '/rooms/:id/equipment',
    { onRequest: [app.authenticate] },
    async (req) => roomService.equipment(req.scope, req.params.id),
  );

  app.get<{ Params: { id: string } }>(
    '/rooms/:id/availability',
    { onRequest: [app.authenticate] },
    async (req) => {
      const { from, to } = window.parse(req.query);
      return roomService.availability(req.scope, req.params.id, from, to);
    },
  );
}

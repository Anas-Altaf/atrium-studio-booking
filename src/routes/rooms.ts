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

export async function roomRoutes(app: FastifyInstance): Promise<void> {
  app.get('/rooms', { onRequest: [app.authenticate] }, async (req) => {
    const criteria = searchQuery.parse(req.query);
    return roomService.search(req.scope, criteria);
  });
}

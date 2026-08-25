import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as bookingService from '../services/bookingService.js';

const holdBody = z.object({
  roomId: z.string().uuid(),
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  equipment: z.array(z.object({
    equipmentTypeId: z.string().uuid(),
    quantity: z.number().int().positive(),
  })).default([]),
});

export async function bookingRoutes(app: FastifyInstance): Promise<void> {
  app.post('/bookings/hold', { onRequest: [app.authenticate] }, async (req, reply) => {
    const body = holdBody.parse(req.body);
    const booking = await bookingService.createHold(req.scope, body);
    return reply.code(201).send(booking);
  });

  /**
   * INV-6. The scope is applied inside the repository's predicate, so a booking
   * belonging to another venue is not found rather than refused — a 403 would
   * confirm it exists (A8).
   */
  app.get<{ Params: { id: string } }>(
    '/bookings/:id',
    { onRequest: [app.authenticate] },
    async (req) => bookingService.findById(req.scope, req.params.id),
  );
}

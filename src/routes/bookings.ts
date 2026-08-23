import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHold, findById } from '../repositories/bookingRepo.js';
import { notFound } from '../errors.js';

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
    const booking = await createHold(req.scope, body);
    return reply.code(201).send(booking);
  });

  /**
   * INV-6. The scope is applied inside the repository, so a booking belonging
   * to another venue is not found rather than refused — a 403 would confirm it
   * exists (A8).
   */
  app.get<{ Params: { id: string } }>(
    '/bookings/:id',
    { onRequest: [app.authenticate] },
    async (req) => {
      const booking = await findById(req.scope, req.params.id);
      if (!booking) throw notFound('booking not found');
      return booking;
    },
  );
}

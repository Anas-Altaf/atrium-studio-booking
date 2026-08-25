import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as bookingService from '../services/bookingService.js';
import * as cancellationService from '../services/cancellationService.js';

const holdBody = z.object({
  roomId: z.string().uuid(),
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  equipment: z.array(z.object({
    equipmentTypeId: z.string().uuid(),
    quantity: z.number().int().positive(),
  })).default([]),
});

const listQuery = z.object({
  status: z.string()
    .transform((v) => v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))
    .optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export async function bookingRoutes(app: FastifyInstance): Promise<void> {
  /** Scoped by role: a customer's own, a venue's, or everything. */
  app.get('/bookings', { onRequest: [app.authenticate] }, async (req) => {
    const filter = listQuery.parse(req.query);
    return bookingService.list(req.scope, filter);
  });

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

  /** The append-only trail, scoped through the booking it belongs to. */
  app.get<{ Params: { id: string } }>(
    '/bookings/:id/audit',
    { onRequest: [app.authenticate] },
    async (req) => bookingService.auditTrail(req.scope, req.params.id),
  );

  /** Re-issues the hold for the checkout window the brief guarantees (A1). */
  app.post<{ Params: { id: string } }>(
    '/bookings/:id/checkout',
    { onRequest: [app.authenticate] },
    async (req) => bookingService.startCheckout(req.scope, req.params.id),
  );

  /** 200 either way: a repeat cancel is a replay, and returns the same refund. */
  app.post<{ Params: { id: string } }>(
    '/bookings/:id/cancel',
    { onRequest: [app.authenticate] },
    async (req) => cancellationService.cancel(req.scope, req.params.id),
  );
}

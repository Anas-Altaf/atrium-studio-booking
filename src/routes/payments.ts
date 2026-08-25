import type { FastifyInstance } from 'fastify';
import * as paymentService from '../services/paymentService.js';
import * as webhookService from '../services/webhookService.js';

export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  /** 202 when the charge was created, 200 when one already existed (INV-3). */
  app.post<{ Params: { id: string } }>(
    '/bookings/:id/pay',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const result = await paymentService.submitForPayment(req.scope, req.params.id);
      return reply.code(result.created ? 202 : 200).send({
        paymentId: result.payment.id,
        status: result.payment.status,
        amountMinor: result.payment.amount_minor,
        currency: result.payment.currency,
        chargeId: result.payment.charge_id,
      });
    },
  );

  await app.register(webhookRoutes);
}

/**
 * Its own plugin because `addContentTypeParser` applies to the whole
 * encapsulation context. At the top level it would hand every JSON route a raw
 * string instead of a parsed body.
 */
async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser(
    'application/json', { parseAs: 'string' },
    (_req, body, done) => { done(null, { raw: body as string }); },
  );

  app.post('/webhooks/paygate', async (req, reply) => {
    const { raw } = (req.body ?? { raw: '' }) as { raw: string };

    const result = await webhookService.intake({
      rawBody: raw,
      signature: req.headers['x-paygate-signature'] as string | undefined,
      deliveryId: (req.headers['x-paygate-delivery'] as string | undefined) ?? null,
      correlationId: req.id,
    });

    // 200 whether new or a redelivery: anything else earns another copy.
    return reply.code(200).send({ received: true, duplicate: !result.recorded });
  });
}

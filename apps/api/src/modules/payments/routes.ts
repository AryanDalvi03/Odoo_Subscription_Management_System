import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Payment, PaymentOrder, WebhookEvent, Invoice } from '../../models/index.js';
import { authenticate, type AuthConfig, hashToken } from '../auth/service.js';
import { actorOf, listQuery } from '../catalog/routes.js';
import { resourceScope, objectId, permit } from '../../services/context.js';
import { ensure } from '../../lib/errors.js';
import { id, minor } from '../catalog/schemas.js';
import { verifySignature, createOrder, postPayment, reconcilePayment } from './service.js';
export async function razorpayWebhook(req: Request, res: Response) {
  ensure(
    process.env.RAZORPAY_WEBHOOK_SECRET,
    503,
    'WEBHOOK_UNCONFIGURED',
    'Webhook is not configured',
  );
  ensure(Buffer.isBuffer(req.body), 400, 'INVALID_BODY', 'Expected raw webhook body');
  const signature = req.get('x-razorpay-signature') ?? '';
  ensure(
    verifySignature(req.body.toString('utf8'), signature, process.env.RAZORPAY_WEBHOOK_SECRET),
    400,
    'INVALID_SIGNATURE',
    'Invalid webhook signature',
  );
  const body = z
    .object({ event: z.string(), payload: z.record(z.string(), z.unknown()) })
    .passthrough()
    .parse(JSON.parse(req.body.toString('utf8')));
  const eventId = z.string().min(1).max(200).parse(req.get('x-razorpay-event-id'));
  const payloadHash = hashToken(req.body.toString('utf8'));
  const previous = await WebhookEvent.findOne({ eventId });
  if (previous)
    ensure(
      previous.payloadHash === payloadHash,
      409,
      'EVENT_REUSED',
      'Event identity has another payload',
    );
  else await WebhookEvent.create({ eventId, payloadHash, payload: body, status: 'pending' });
  res.json({ data: { received: true } });
}
export function paymentRoutes(config: AuthConfig) {
  const router = Router();
  router.use(async (req, res, next) => {
    res.locals.actor ??= await authenticate(req.get('authorization'), config);
    if (actorOf(res).role === 'staff' && req.path.startsWith('/payments'))
      permit(actorOf(res), 'payments:write');
    next();
  });
  router.get('/payments', async (req, res) => {
    const actor = actorOf(res);
    if (actor.role === 'staff') permit(actor, 'payments:write');
    const q = listQuery.parse(req.query);
    const scope: Record<string, unknown> = {
      ...(await resourceScope(actor)),
      ...(q.status ? { status: q.status } : {}),
    };
    res.json({
      data: await Payment.find(scope)
        .sort('-paidAt')
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize),
      meta: { total: await Payment.countDocuments(scope), page: q.page, pageSize: q.pageSize },
    });
  });
  router.get('/payments/:id', async (req, res) => {
    const row = await Payment.findOne({
      _id: objectId(req.params.id),
      ...(await resourceScope(actorOf(res))),
    });
    ensure(row, 404, 'NOT_FOUND', 'Payment not found');
    res.json({ data: row });
  });
  router.post('/payments', async (req, res) => {
    const actor = actorOf(res);
    const body = z
      .object({
        invoiceId: id,
        amountMinor: minor.refine((v) => v > 0),
        method: z.enum(['bank_transfer', 'cash', 'upi', 'card', 'other']),
        reference: z.string().min(3).max(150),
        notes: z.string().max(2000).optional(),
      })
      .strict()
      .parse(req.body);
    const key = `payment-${actor.id}-${z
      .string()
      .min(8)
      .max(100)
      .parse(req.get('Idempotency-Key') ?? randomUUID())}`;
    res.status(201).json({ data: await postPayment({ ...body, key, provider: 'manual' }, actor) });
  });
  router.post('/payments/create-order', async (req, res) => {
    const actor = actorOf(res);
    const body = z
      .object({ invoiceId: id, amountMinor: minor.refine((v) => v > 0) })
      .strict()
      .parse(req.body);
    const key = `order-${actor.id}-${z.string().min(8).max(100).parse(req.get('Idempotency-Key'))}`;
    res.status(201).json({ data: await createOrder(actor, body.invoiceId, body.amountMinor, key) });
  });
  router.post('/payments/verify', async (req, res) => {
    const body = z
      .object({
        razorpay_order_id: z.string().max(100),
        razorpay_payment_id: z.string().max(100),
        razorpay_signature: z.string().length(64),
      })
      .strict()
      .parse(req.body);
    const order = await PaymentOrder.findOne({
      providerOrderId: body.razorpay_order_id,
      ...(await resourceScope(actorOf(res))),
    });
    ensure(order, 404, 'NOT_FOUND', 'Order not found');
    ensure(
      process.env.RAZORPAY_KEY_SECRET,
      503,
      'PAYMENT_UNCONFIGURED',
      'Razorpay is not configured',
    );
    ensure(
      verifySignature(
        `${order.providerOrderId}|${body.razorpay_payment_id}`,
        body.razorpay_signature,
        process.env.RAZORPAY_KEY_SECRET,
      ),
      400,
      'INVALID_SIGNATURE',
      'Payment signature is invalid',
    );
    res.json({
      data: await reconcilePayment(body.razorpay_payment_id, order.providerOrderId ?? undefined),
    });
  });
  return router;
}

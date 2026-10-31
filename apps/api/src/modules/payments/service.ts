import mongoose from 'mongoose';
import { createHmac, timingSafeEqual } from 'node:crypto';
import Razorpay from 'razorpay';
import { outstanding } from '@subscriptiq/domain';
import {
  Invoice,
  Payment,
  PaymentAllocation,
  PaymentOrder,
  Command,
  WebhookEvent,
} from '../../models/index.js';
import { audit, notify, permit, resourceScope, type Actor } from '../../services/context.js';
import { hashToken } from '../auth/service.js';
import { ensure } from '../../lib/errors.js';
export function verifySignature(value: string, signature: string, secret: string) {
  const expected = createHmac('sha256', secret).update(value).digest();
  const received = Buffer.from(signature, 'hex');
  return received.length === expected.length && timingSafeEqual(expected, received);
}
export function gateway() {
  ensure(
    process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET,
    503,
    'PAYMENT_UNCONFIGURED',
    'Razorpay is not configured',
  );
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}
export async function postPayment(
  input: {
    invoiceId: string;
    amountMinor: number;
    method: string;
    reference: string;
    notes?: string;
    key: string;
    provider: 'manual' | 'razorpay';
    providerPaymentId?: string;
  },
  actor?: Actor,
) {
  if (actor && actor.role !== 'customer') permit(actor, 'payments:write');
  const hash = hashToken(JSON.stringify(input));
  return mongoose.connection.transaction(async (session) => {
    const previous = await Command.findOne({ key: input.key }).session(session);
    if (previous) {
      ensure(
        previous.hash === hash,
        409,
        'KEY_REUSED',
        'Idempotency key was used for another request',
      );
      return Payment.findById(previous.resultId).session(session);
    }
    if (input.providerPaymentId) {
      const captured = await Payment.findOne({
        providerPaymentId: input.providerPaymentId,
        status: 'captured',
      }).session(session);
      if (captured) return captured;
    }
    const invoice = await Invoice.findOne({
      _id: input.invoiceId,
      ...(actor ? await resourceScope(actor) : {}),
      status: 'confirmed',
    }).session(session);
    ensure(invoice, 404, 'NOT_FOUND', 'Payable invoice not found');
    const balance = outstanding(invoice);
    if (input.provider === 'manual')
      ensure(
        input.amountMinor <= balance,
        409,
        'OVERPAYMENT',
        'Payment exceeds outstanding balance',
      );
    const allocation = Math.min(balance, input.amountMinor);
    const paymentData = {
      customerId: invoice.customerId,
      amountMinor: input.amountMinor,
      allocatedMinor: allocation,
      method: input.method,
      reference: input.reference,
      notes: input.notes,
      provider: input.provider,
      providerPaymentId: input.providerPaymentId,
      idempotencyKey: input.key,
      status: 'captured' as const,
      paidAt: new Date(),
    };
    let payment = input.providerPaymentId
      ? await Payment.findOne({
          providerPaymentId: input.providerPaymentId,
          status: 'failed',
        }).session(session)
      : null;
    if (payment) {
      payment.set(paymentData);
      await payment.save({ session });
    } else {
      const created = await Payment.create([paymentData], { session });
      payment = created[0]!;
    }
    if (allocation > 0) {
      await PaymentAllocation.create(
        [{ paymentId: payment!._id, invoiceId: invoice._id, amountMinor: allocation }],
        { session },
      );
      invoice.paidMinor += allocation;
      await invoice.save({ session });
    }
    await Command.create(
      [{ key: input.key, hash, resultId: String(payment!._id), type: 'payment' }],
      { session },
    );
    await audit(
      actor,
      'payment_received',
      'Invoice',
      invoice._id,
      { paymentId: payment!._id, amountMinor: input.amountMinor, allocation },
      session,
    );
    await notify(
      invoice.customerSnapshot!.email!,
      'Payment received',
      `Received INR ${(input.amountMinor / 100).toFixed(2)} for invoice ${invoice.number}. Any surplus remains unallocated customer credit.`,
      `paid-${payment!._id}`,
      session,
    );
    return payment!;
  });
}
export async function createOrder(
  actor: Actor,
  invoiceId: string,
  amountMinor: number,
  key: string,
) {
  const provider = gateway();
  const invoice = await Invoice.findOne({
    _id: invoiceId,
    ...(await resourceScope(actor)),
    status: 'confirmed',
  });
  ensure(invoice, 404, 'NOT_FOUND', 'Invoice not found');
  ensure(
    amountMinor > 0 && amountMinor <= outstanding(invoice),
    422,
    'INVALID_AMOUNT',
    'Choose a positive amount within outstanding balance',
  );
  let row = await PaymentOrder.findOne({ requestKey: key });
  if (row) {
    ensure(
      String(row.invoiceId) === invoiceId && row.amountMinor === amountMinor,
      409,
      'KEY_REUSED',
      'Idempotency key used for another order',
    );
    if (row.providerOrderId)
      return { orderId: row.providerOrderId, amountMinor, keyId: process.env.RAZORPAY_KEY_ID };
    const recovered = await provider.orders.all({ receipt: String(row._id) });
    const matching = recovered.items.filter(
      (order) => Number(order.amount) === amountMinor && order.currency === 'INR',
    );
    ensure(
      matching.length === 1,
      409,
      'ORDER_UNCERTAIN',
      'Order creation is pending reconciliation; do not create another payment',
    );
    row.providerOrderId = matching[0]!.id;
    row.status = 'created';
    await row.save();
    return { orderId: row.providerOrderId, amountMinor, keyId: process.env.RAZORPAY_KEY_ID };
  }
  row = await PaymentOrder.create({
    customerId: invoice.customerId,
    invoiceId,
    amountMinor,
    requestKey: key,
    status: 'creating',
  });
  try {
    const order = await provider.orders.create({
      amount: amountMinor,
      currency: 'INR',
      receipt: String(row._id),
    });
    row.providerOrderId = order.id;
    row.status = 'created';
    await row.save();
    return { orderId: order.id, amountMinor, keyId: process.env.RAZORPAY_KEY_ID };
  } catch (error) {
    row.status = 'uncertain';
    await row.save();
    throw error;
  }
}
export async function reconcilePayment(providerPaymentId: string, expectedOrderId?: string) {
  const payment = await gateway().payments.fetch(providerPaymentId);
  ensure(
    payment.order_id && (!expectedOrderId || expectedOrderId === payment.order_id),
    422,
    'ORDER_MISMATCH',
    'Payment order does not match',
  );
  const order = await PaymentOrder.findOne({ providerOrderId: payment.order_id });
  ensure(order, 404, 'ORDER_UNKNOWN', 'Payment order not found');
  ensure(
    payment.currency === 'INR' && Number(payment.amount) === order.amountMinor,
    422,
    'PAYMENT_MISMATCH',
    'Payment amount or currency does not match',
  );
  if (payment.status === 'captured') {
    const posted = await postPayment({
      invoiceId: String(order.invoiceId),
      amountMinor: order.amountMinor,
      method: payment.method,
      reference: providerPaymentId,
      key: `razorpay-${providerPaymentId}`,
      provider: 'razorpay',
      providerPaymentId,
    });
    await PaymentOrder.updateOne({ _id: order._id }, { status: 'paid' });
    return posted;
  }
  if (payment.status === 'failed') {
    await PaymentOrder.updateOne({ _id: order._id }, { status: 'failed' });
    await Payment.updateOne(
      { providerPaymentId },
      {
        $setOnInsert: {
          customerId: order.customerId,
          amountMinor: order.amountMinor,
          method: payment.method,
          reference: providerPaymentId,
          provider: 'razorpay',
          idempotencyKey: `failed-${providerPaymentId}`,
          status: 'failed',
          paidAt: new Date(),
        },
      },
      { upsert: true },
    );
    const invoice = await Invoice.findById(order.invoiceId);
    if (invoice)
      await notify(
        invoice.customerSnapshot!.email!,
        'Payment failed',
        `Payment for invoice ${invoice.number} was not captured. Please sign in to retry.`,
        `failed-${providerPaymentId}`,
      );
  }
  return { status: payment.status };
}
export async function processWebhook(id: string) {
  const event = await WebhookEvent.findById(id);
  if (!event || event.status === 'processed') return;
  const paymentId = event.payload?.payload?.payment?.entity?.id;
  if (typeof paymentId === 'string') await reconcilePayment(paymentId);
  event.status = 'processed';
  await event.save();
}

import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes, createHmac } from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import { pino } from 'pino';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  User,
  Customer,
  Invoice,
  Subscription,
  Plan,
  Product,
  Payment,
  PaymentAllocation,
  WebhookEvent,
} from '../../apps/api/src/models/index.js';
import {
  postPayment,
  verifySignature,
  reconcilePayment,
} from '../../apps/api/src/modules/payments/service.js';
import nock from 'nock';
import { PaymentOrder } from '../../apps/api/src/models/index.js';
import { analytics } from '../../apps/api/src/modules/analytics/routes.js';
import { createSession } from '../../apps/api/src/modules/auth/service.js';
import { createApp } from '../../apps/api/src/app.js';
import type { Actor } from '../../apps/api/src/services/context.js';
const dbName = `subscriptiq_test_payments_${Date.now()}`;
await mongoose.connect(process.env.MONGODB_URI!, { dbName });
try {
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  const config = {
    secret: randomBytes(48).toString('hex'),
    origin: 'http://localhost:5173',
    production: false,
  };
  const admin = await User.create({
    name: 'Admin',
    email: 'admin@example.test',
    role: 'admin',
    passwordHash: 'test-only',
    verifiedAt: new Date(),
  });
  const actor: Actor = {
    id: String(admin._id),
    role: 'admin',
    name: admin.name,
    email: admin.email,
    permissions: [],
  };
  const buyer = await User.create({
    name: 'Other',
    email: 'other@example.test',
    role: 'customer',
    passwordHash: 'test-only',
    verifiedAt: new Date(),
  });
  const customer = await Customer.create({ name: 'Paying customer', email: 'pay@example.test' });
  const product = await Product.create({
    name: 'Product',
    salesPriceMinor: 10000,
    costPriceMinor: 1000,
  });
  const plan = await Plan.create({
    name: 'Plan',
    products: [{ productId: product._id, unitPriceMinor: 10000 }],
    frequency: 'monthly',
  });
  const sub = await Subscription.create({
    number: 'SUB-TEST',
    customerId: customer._id,
    planId: plan._id,
    startAt: new Date(),
    nextBillingAt: new Date(),
    frequency: 'monthly',
    anchorDay: 1,
    anchorMonth: 1,
    subtotalMinor: 10000,
    discountMinor: 0,
    taxMinor: 0,
    totalMinor: 10000,
  });
  const invoice = await Invoice.create({
    number: 'INV-TEST',
    lines: [
      {
        productId: product._id,
        name: 'Accounting Software - Standard',
        quantity: 1,
        unitPriceMinor: 10000,
        baseMinor: 10000,
        discountMinor: 0,
        taxMinor: 0,
        totalMinor: 10000,
      },
    ],
    customerId: customer._id,
    subscriptionId: sub._id,
    customerSnapshot: { name: customer.name, email: customer.email },
    issuedAt: new Date(),
    dueAt: new Date(),
    subtotalMinor: 10000,
    discountMinor: 0,
    taxMinor: 0,
    totalMinor: 10000,
  });
  const input = {
    invoiceId: String(invoice._id),
    amountMinor: 3000,
    method: 'bank_transfer',
    reference: 'REF-TEST',
    key: 'manual-test-one',
    provider: 'manual' as const,
  };
  const first = await postPayment(input, actor);
  assert.equal((await Invoice.findById(invoice._id))!.paidMinor, 3000);
  assert.equal(String((await postPayment(input, actor))!._id), String(first!._id));
  assert.equal(await Payment.countDocuments(), 1);
  await assert.rejects(() => postPayment({ ...input, amountMinor: 4000 }, actor));
  await assert.rejects(() => postPayment({ ...input, key: 'too-much', amountMinor: 9000 }, actor));
  await postPayment({ ...input, key: 'manual-test-two', amountMinor: 7000 }, actor);
  assert.equal((await Invoice.findById(invoice._id))!.paidMinor, 10000);
  assert.equal(await PaymentAllocation.countDocuments(), 2);
  const app = createApp({
    origin: config.origin,
    auth: config,
    logger: pino({ level: 'silent' }),
    health: async () => ({
      status: 'ready',
      checks: { database: true, redis: true, transactions: true, worker: true },
    }),
  });
  const token = (await createSession(String(buyer._id), config)).accessToken;
  assert.equal(
    (await request(app).get(`/api/invoices/${invoice._id}`).set('Authorization', `Bearer ${token}`))
      .status,
    404,
  );
  assert.equal(
    (
      await request(app)
        .get(`/api/invoices/${invoice._id}/pdf`)
        .set('Authorization', `Bearer ${token}`)
    ).status,
    404,
  );
  process.env.RAZORPAY_WEBHOOK_SECRET = randomBytes(32).toString('hex');
  const body = JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_test' } } },
  });
  const signature = createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(body)
    .digest('hex');
  assert(verifySignature(body, signature, process.env.RAZORPAY_WEBHOOK_SECRET));
  assert(!verifySignature(body + 'x', signature, process.env.RAZORPAY_WEBHOOK_SECRET));
  assert.equal(
    (
      await request(app)
        .post('/api/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('x-razorpay-signature', '00'.repeat(32))
        .set('x-razorpay-event-id', 'event-test')
        .send(body)
    ).status,
    400,
  );
  for (let n = 0; n < 2; n++)
    assert.equal(
      (
        await request(app)
          .post('/api/webhooks/razorpay')
          .set('Content-Type', 'application/json')
          .set('x-razorpay-signature', signature)
          .set('x-razorpay-event-id', 'event-test')
          .send(body)
      ).status,
      200,
    );
  assert.equal(await WebhookEvent.countDocuments(), 1);
  const totals = await analytics(actor, { range: '30' });
  assert.equal(totals.metrics.collectedMinor, 10000);
  assert.equal(totals.metrics.outstandingMinor, 0);
  assert.equal(totals.metrics.paymentSuccessRate, 100);
  const adminToken = (await createSession(String(admin._id), config)).accessToken;
  const pdf = await request(app)
    .get(`/api/invoices/${invoice._id}/pdf`)
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers['content-type'], /application\/pdf/);
  assert(Buffer.isBuffer(pdf.body) && pdf.body.subarray(0, 4).toString() === '%PDF');
  await mkdir('tmp/pdfs', { recursive: true });
  await writeFile('tmp/pdfs/invoice-check.pdf', pdf.body);
  const onlineInvoice = await Invoice.create({
    number: 'INV-ONLINE',
    customerId: customer._id,
    subscriptionId: sub._id,
    customerSnapshot: { name: customer.name, email: customer.email },
    issuedAt: new Date(),
    dueAt: new Date(),
    subtotalMinor: 20000,
    discountMinor: 0,
    taxMinor: 0,
    totalMinor: 20000,
  });
  await PaymentOrder.create({
    customerId: customer._id,
    invoiceId: onlineInvoice._id,
    amountMinor: 5000,
    providerOrderId: 'order_test',
    requestKey: 'order-test',
  });
  process.env.RAZORPAY_KEY_ID = 'test-key';
  process.env.RAZORPAY_KEY_SECRET = randomBytes(32).toString('hex');
  nock('https://api.razorpay.com').get('/v1/payments/pay_authorized').reply(200, {
    id: 'pay_authorized',
    order_id: 'order_test',
    currency: 'INR',
    amount: 5000,
    status: 'authorized',
    method: 'upi',
  });
  await reconcilePayment('pay_authorized');
  assert.equal((await Invoice.findById(onlineInvoice._id))!.paidMinor, 0);
  nock('https://api.razorpay.com').get('/v1/payments/pay_captured').twice().reply(200, {
    id: 'pay_captured',
    order_id: 'order_test',
    currency: 'INR',
    amount: 5000,
    status: 'captured',
    method: 'upi',
  });
  await reconcilePayment('pay_captured');
  await reconcilePayment('pay_captured');
  assert.equal((await Invoice.findById(onlineInvoice._id))!.paidMinor, 5000);
  assert.equal(await Payment.countDocuments({ providerPaymentId: 'pay_captured' }), 1);
  nock('https://api.razorpay.com').get('/v1/payments/pay_wrong').reply(200, {
    id: 'pay_wrong',
    order_id: 'order_test',
    currency: 'USD',
    amount: 5000,
    status: 'captured',
    method: 'card',
  });
  await assert.rejects(() => reconcilePayment('pay_wrong'));
  const wrongSignature = await request(app)
    .post('/api/payments/verify')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      razorpay_order_id: 'order_test',
      razorpay_payment_id: 'pay_captured',
      razorpay_signature: '00'.repeat(32),
    });
  assert.equal(wrongSignature.status, 400);
  assert(nock.isDone());
  const credit = await request(app)
    .post(`/api/invoices/${onlineInvoice._id}/credit-notes`)
    .set('Authorization', `Bearer ${adminToken}`)
    .set('Idempotency-Key', 'credit-test-001')
    .send({ amountMinor: 3000, reason: 'Test service adjustment' });
  assert.equal(credit.status, 201);
  assert.equal((await Invoice.findById(onlineInvoice._id))!.creditedMinor, 3000);
  assert.equal((await analytics(actor, { range: '30' })).metrics.outstandingMinor, 12000);
  await Promise.all(
    [1, 2].map((index) =>
      postPayment(
        {
          invoiceId: String(onlineInvoice._id),
          amountMinor: 6000,
          method: 'bank_transfer',
          reference: `CONCURRENT-${index}`,
          key: `concurrent-${index}`,
          provider: 'manual',
        },
        actor,
      ),
    ),
  );
  assert.equal((await Invoice.findById(onlineInvoice._id))!.paidMinor, 17000);
  assert.equal((await analytics(actor, { range: '30' })).metrics.outstandingMinor, 0);
  console.log(
    'PASS payments: partial/multiple payments, idempotency conflicts, overpayment rejection, allocation reconciliation, cross-customer invoice/PDF isolation, raw webhook signature rejection and duplicate receipts',
  );
} finally {
  assert(dbName.startsWith('subscriptiq_test_'));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

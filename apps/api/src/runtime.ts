import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { Resend } from 'resend';
import type { Logger } from 'pino';
import mongoose from 'mongoose';
import {
  Subscription,
  Quotation,
  Customer,
  Notification,
  WebhookEvent,
  Invoice,
  PaymentOrder,
  SubscriptionEvent,
} from './models/index.js';
import { notify, audit } from './services/context.js';
import { billCycle } from './modules/billing/service.js';
import { retireDrafts } from './modules/invoices/service.js';
import { processWebhook, reconcilePayment, gateway } from './modules/payments/service.js';
export const queueNames = [
  'subscriptiq-operations',
  'subscriptiq-billing',
  'subscriptiq-email',
] as const;
async function deliver(id: string) {
  const notification = await Notification.findById(id);
  if (!notification || notification.status === 'sent') return;
  await Notification.updateOne({ _id: id }, { $inc: { attempts: 1 } });
  try {
    if (process.env.MAIL_TRANSPORT === 'local' && process.env.NODE_ENV !== 'production') {
      const directory = path.resolve(process.env.MAIL_DIRECTORY ?? '../../var/mail');
      await mkdir(directory, { recursive: true });
      const filename = path.join(directory, `${id}.eml`);
      const temp = `${filename}.tmp`;
      await writeFile(
        temp,
        `To: ${notification.recipient}\r\nSubject: ${notification.subject.replace(/[\r\n]/g, ' ')}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${notification.text}`,
        { mode: 0o600 },
      );
      await rename(temp, filename);
      notification.providerMessageId = `local-file-${id}`;
    } else {
      if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM)
        throw new Error('Email provider not configured');
      const result = await new Resend(process.env.RESEND_API_KEY).emails.send(
        {
          from: process.env.EMAIL_FROM,
          to: notification.recipient,
          subject: notification.subject,
          text: notification.text,
        },
        { idempotencyKey: id },
      );
      if (result.error) throw new Error('Email provider rejected delivery');
      notification.providerMessageId = result.data!.id;
    }
    notification.status = 'sent';
    notification.sentAt = new Date();
    notification.lastError = undefined;
    await notification.save();
  } catch {
    await Notification.updateOne(
      { _id: id },
      {
        status: 'failed',
        lastError: 'Email delivery failed. Check provider configuration and retry.',
      },
    );
    throw new Error('Email delivery failed');
  }
}
export async function startJobSystem(url: string, logger: Logger) {
  const connection = new Redis(url, { maxRetriesPerRequest: null });
  connection.on('error', () => logger.error('Job Redis connection unavailable'));
  const options = {
    connection,
    prefix: process.env.QUEUE_PREFIX ?? 'subscriptiq',
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000, jitter: 0.3 },
      removeOnComplete: { age: 7 * 86400, count: 10000 },
      removeOnFail: { age: 30 * 86400 },
    },
  };
  const operations = new Queue(queueNames[0], options);
  const billing = new Queue(queueNames[1], options);
  const email = new Queue(queueNames[2], options);
  const billingWorker = new Worker(
    queueNames[1],
    async (job) => {
      const data = job.data as { subscriptionId: string; cycle: string };
      return String((await billCycle(data.subscriptionId, new Date(data.cycle))) ?? 'boundary');
    },
    { connection, prefix: process.env.QUEUE_PREFIX ?? 'subscriptiq', concurrency: 10 },
  );
  const emailWorker = new Worker(
    queueNames[2],
    async (job) => deliver(String(job.data.notificationId)),
    { connection, prefix: process.env.QUEUE_PREFIX ?? 'subscriptiq', concurrency: 5 },
  );
  const operationsWorker = new Worker(
    queueNames[0],
    async (job) => {
      if (job.name === 'webhook') return processWebhook(String(job.data.eventId));
      const now = new Date();
      const expiring = await Subscription.find({ status: 'active', expiryAt: { $lte: now } })
        .select('_id')
        .limit(100)
        .lean();
      for (const candidate of expiring)
        await mongoose.connection.transaction(async (session) => {
          const sub = await Subscription.findOne({
            _id: candidate._id,
            status: 'active',
            expiryAt: { $lte: now },
          }).session(session);
          if (!sub) return;
          sub.status = sub.planSnapshot?.autoClose ? 'closed' : 'paused';
          await retireDrafts(String(sub._id), session, 'Subscription expired');
          await sub.save({ session });
          await SubscriptionEvent.create(
            [
              {
                subscriptionId: sub._id,
                action: 'expired',
                from: 'active',
                to: sub.status,
                recurringMinor: 0,
                frequency: sub.frequency,
                effectiveAt: sub.expiryAt!,
              },
            ],
            { session },
          );
          await audit(
            undefined,
            'expired',
            'Subscription',
            sub._id,
            { status: sub.status },
            session,
          );
          const customer = await Customer.findById(sub.customerId).session(session);
          if (customer)
            await notify(
              customer.email,
              'Subscription expired',
              `Subscription ${sub.number} has expired. No further cycles will be billed.`,
              `expired-${sub._id}`,
              session,
            );
        });
      const due = await Subscription.find({ status: 'active', nextBillingAt: { $lte: now } })
        .select('_id nextBillingAt')
        .sort('nextBillingAt')
        .limit(500)
        .lean();
      if (due.length)
        await billing.addBulk(
          due.map((sub) => ({
            name: 'bill',
            data: { subscriptionId: String(sub._id), cycle: sub.nextBillingAt.toISOString() },
            opts: { jobId: `${sub._id}-${sub.nextBillingAt.getTime()}` },
          })),
        );
      const pending = await Notification.find({
        status: { $in: ['pending', 'failed'] },
        attempts: { $lt: 5 },
      })
        .select('_id')
        .limit(500)
        .lean();
      if (pending.length)
        await email.addBulk(
          pending.map((row) => ({
            name: 'deliver',
            data: { notificationId: String(row._id) },
            opts: { jobId: String(row._id) },
          })),
        );
      const hooks = await WebhookEvent.find({ status: 'pending' }).select('_id').limit(100).lean();
      if (hooks.length)
        await operations.addBulk(
          hooks.map((row) => ({
            name: 'webhook',
            data: { eventId: String(row._id) },
            opts: { jobId: `hook-${row._id}` },
          })),
        );
      await Quotation.updateMany(
        {
          status: { $in: ['draft', 'sent', 'accepted'] },
          expiryAt: { $lte: now },
          convertedSubscriptionId: { $exists: false },
        },
        { status: 'expired' },
      );
      const soon = await Quotation.find({
        status: 'sent',
        expiryAt: { $gt: now, $lt: new Date(now.getTime() + 86400_000) },
      })
        .limit(100)
        .lean();
      for (const quote of soon) {
        const customer = await Customer.findById(quote.customerId);
        if (customer)
          await notify(
            customer.email,
            `Quotation ${quote.number} expires soon`,
            'Sign in to review your quotation before it expires.',
            `quote-expiry-${quote._id}`,
          );
      }
      const invoices = await Invoice.find({
        status: 'confirmed',
        $expr: {
          $gt: [{ $subtract: ['$totalMinor', { $add: ['$paidMinor', '$creditedMinor'] }] }, 0],
        },
        dueAt: { $lte: new Date(now.getTime() + 86400_000) },
      })
        .limit(500)
        .lean();
      const day = now.toISOString().slice(0, 10);
      for (const invoice of invoices) {
        const overdue = invoice.dueAt < now;
        await notify(
          invoice.customerSnapshot!.email!,
          overdue ? `Overdue invoice ${invoice.number}` : `Invoice ${invoice.number} is due`,
          `Sign in to review and pay the remaining balance.`,
          `${overdue ? 'overdue' : 'due'}-${invoice._id}-${day}`,
        );
      }
      if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
        const orders = await PaymentOrder.find({
          status: { $in: ['created', 'uncertain', 'creating'] },
          updatedAt: { $lt: new Date(Date.now() - 60_000) },
        })
          .sort('updatedAt')
          .limit(25);
        for (const order of orders) {
          try {
            if (!order.providerOrderId) {
              const found = await gateway().orders.all({ receipt: String(order._id) });
              if (found.items.length === 1) {
                order.providerOrderId = found.items[0]!.id;
                order.status = 'created';
                await order.save();
              }
            }
            if (order.providerOrderId) {
              const attempts = await gateway().orders.fetchPayments(order.providerOrderId);
              for (const payment of attempts.items)
                if (payment.status === 'captured' || payment.status === 'failed')
                  await reconcilePayment(payment.id);
            }
          } catch {
            logger.warn({ orderId: String(order._id) }, 'Payment reconciliation requires retry');
          }
        }
      }
    },
    { connection, prefix: process.env.QUEUE_PREFIX ?? 'subscriptiq', concurrency: 1 },
  );
  for (const worker of [billingWorker, emailWorker, operationsWorker]) {
    worker.on('error', () => logger.error({ queue: worker.name }, 'Worker error'));
    worker.on('failed', (job) =>
      logger.error({ queue: worker.name, jobId: job?.id }, 'Job failed'),
    );
  }
  await operations.upsertJobScheduler('scan', { every: 30_000 }, { name: 'scan', data: {} });
  return {
    close: async () => {
      await Promise.all([operationsWorker.close(), billingWorker.close(), emailWorker.close()]);
      await Promise.all([operations.close(), billing.close(), email.close()]);
      connection.disconnect();
    },
  };
}

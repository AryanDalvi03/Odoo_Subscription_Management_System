import 'dotenv/config';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { pino } from 'pino';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  Product,
  Plan,
  Customer,
  Subscription,
  Invoice,
  Notification,
} from '../../apps/api/src/models/index.js';
import { startJobSystem, queueNames } from '../../apps/api/src/runtime.js';
const dbName = `subscriptiq_test_workers_${Date.now()}`;
process.env.QUEUE_PREFIX = dbName;
process.env.MAIL_TRANSPORT = 'local';
process.env.NODE_ENV = 'test';
const directory = await mkdtemp(path.join(os.tmpdir(), 'subscriptiq-worker-test-'));
process.env.MAIL_DIRECTORY = directory;
await mongoose.connect(process.env.MONGODB_URI!, { dbName });
const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
let jobs: Awaited<ReturnType<typeof startJobSystem>> | undefined;
try {
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  const customer = await Customer.create({ name: 'Worker customer', email: 'worker@example.test' });
  const product = await Product.create({
    name: 'Worker product',
    salesPriceMinor: 10000,
    costPriceMinor: 1000,
  });
  const plan = await Plan.create({
    name: 'Worker plan',
    products: [{ productId: product._id, unitPriceMinor: 10000 }],
    frequency: 'daily',
  });
  await Subscription.create({
    number: 'SUB-WORKER',
    customerId: customer._id,
    planId: plan._id,
    planSnapshot: { name: plan.name },
    frequency: 'daily',
    startAt: new Date(),
    nextBillingAt: new Date(),
    anchorDay: 1,
    anchorMonth: 1,
    subtotalMinor: 10000,
    discountMinor: 0,
    taxMinor: 0,
    totalMinor: 10000,
    status: 'active',
    lines: [
      {
        productId: product._id,
        name: product.name,
        quantity: 1,
        unitPriceMinor: 10000,
        baseMinor: 10000,
        discountMinor: 0,
        taxMinor: 0,
        totalMinor: 10000,
      },
    ],
  });
  jobs = await startJobSystem(process.env.REDIS_URL!, pino({ level: 'silent' }));
  const operations = new Queue(queueNames[0], { connection, prefix: dbName });
  await operations.add('scan', {});
  const wait = async (check: () => Promise<boolean>) => {
    const end = Date.now() + 15_000;
    while (!(await check())) {
      assert(Date.now() < end, 'Worker timed out');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  await wait(async () => (await Invoice.countDocuments()) === 1);
  await operations.add('scan', {});
  await wait(async () =>
    Boolean(await Notification.exists({ recipient: customer.email, status: 'sent' })),
  );
  const notice = await Notification.findOne({ recipient: customer.email, status: 'sent' });
  assert(
    (await readFile(path.join(directory, `${notice!._id}.eml`), 'utf8')).includes('INR 100.00'),
  );
  await operations.add('scan', {});
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await Invoice.countDocuments(), 1);
  await operations.close();
  console.log(
    'PASS workers: due scan, real BullMQ billing, durable notification dispatch, local .eml delivery and repeated-scan deduplication',
  );
} finally {
  await jobs?.close();
  for (const name of queueNames) {
    const queue = new Queue(name, { connection, prefix: dbName });
    await queue.obliterate({ force: true });
    await queue.close();
  }
  connection.disconnect();
  assert(dbName.startsWith('subscriptiq_test_'));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  assert(
    path
      .resolve(directory)
      .startsWith(path.resolve(os.tmpdir()) + path.sep + 'subscriptiq-worker-test-'),
  );
  await rm(directory, { recursive: true, force: true });
}

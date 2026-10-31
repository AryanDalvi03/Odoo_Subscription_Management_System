import 'dotenv/config';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { pino } from 'pino';
import {
  Product,
  Plan,
  Customer,
  Subscription,
  Invoice,
  BillingRecord,
} from '../../apps/api/src/models/index.js';
import { startJobSystem, queueNames } from '../../apps/api/src/runtime.js';
const dbName = `subscriptiq_test_burst_${Date.now()}`;
process.env.QUEUE_PREFIX = dbName;
process.env.NODE_ENV = 'test';
process.env.MAIL_TRANSPORT = 'local';
process.env.MAIL_DIRECTORY = 'tmp/billing-mail';
await mongoose.connect(process.env.MONGODB_URI!, { dbName });
const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
let jobs: Awaited<ReturnType<typeof startJobSystem>> | undefined;
try {
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  const customer = await Customer.create({ name: 'Burst customer', email: 'burst@example.test' });
  const product = await Product.create({
    name: 'Burst product',
    salesPriceMinor: 10000,
    costPriceMinor: 1000,
  });
  const plan = await Plan.create({
    name: 'Burst plan',
    frequency: 'monthly',
    products: [{ productId: product._id, unitPriceMinor: 10000 }],
  });
  const cycle = new Date();
  await Subscription.insertMany(
    Array.from({ length: 1000 }, (_, index) => ({
      number: `SUB-BURST-${index}`,
      customerId: customer._id,
      planId: plan._id,
      planSnapshot: { name: plan.name },
      startAt: cycle,
      nextBillingAt: cycle,
      frequency: 'monthly',
      anchorDay: cycle.getUTCDate(),
      anchorMonth: cycle.getUTCMonth() + 1,
      status: 'active',
      subtotalMinor: 10000,
      discountMinor: 0,
      taxMinor: 0,
      totalMinor: 10000,
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
    })),
  );
  const started = Date.now();
  jobs = await startJobSystem(process.env.REDIS_URL!, pino({ level: 'silent' }));
  const operations = new Queue(queueNames[0], { connection: redis, prefix: dbName });
  await operations.add('scan', {});
  const deadline = Date.now() + 180000;
  let last = -1;
  while ((await Invoice.countDocuments()) < 1000) {
    assert(Date.now() < deadline, 'Billing burst timed out');
    const count = await Invoice.countDocuments();
    if (Math.floor(count / 100) !== Math.floor(last / 100)) {
      console.log(`Billing burst: ${count}/1000 completed`);
      last = count;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(await Invoice.countDocuments(), 1000);
  assert.equal(await BillingRecord.countDocuments(), 1000);
  assert.equal((await Invoice.distinct('number')).length, 1000);
  assert.equal(await Subscription.countDocuments({ nextBillingAt: { $gt: cycle } }), 1000);
  console.log(
    `PASS: 1000 autonomous billing cycles committed once in ${((Date.now() - started) / 1000).toFixed(1)} seconds`,
  );
  await operations.close();
} finally {
  await jobs?.close();
  for (const name of queueNames) {
    const queue = new Queue(name, { connection: redis, prefix: dbName });
    await queue.obliterate({ force: true });
    await queue.close();
  }
  redis.disconnect();
  assert(dbName.startsWith('subscriptiq_test_'));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

import 'dotenv/config';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pino } from 'pino';
import { createApp } from '../apps/api/src/app.js';
import { createSession } from '../apps/api/src/modules/auth/service.js';
import {
  User,
  Customer,
  Product,
  Plan,
  Subscription,
  Invoice,
  Payment,
} from '../apps/api/src/models/index.js';
const dbName = `subscriptiq_test_load_${Date.now()}`;
const cache = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
await mongoose.connect(process.env.MONGODB_URI!, { dbName });
const config = {
  secret: randomBytes(48).toString('hex'),
  origin: 'http://localhost:5173',
  production: false,
};
let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined;
try {
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  const admin = await User.create({
    name: 'Load Test',
    email: 'load@example.test',
    role: 'admin',
    passwordHash: 'test-only',
    verifiedAt: new Date(),
  });
  const customer = await Customer.create({
    name: 'Load customer',
    email: 'load-customer@example.test',
  });
  const product = await Product.create({
    name: 'Load product',
    salesPriceMinor: 10000,
    costPriceMinor: 1000,
  });
  const plan = await Plan.create({
    name: 'Load plan',
    frequency: 'monthly',
    products: [{ productId: product._id, unitPriceMinor: 10000 }],
  });
  for (let batch = 0; batch < 10; batch++) {
    const subs = await Subscription.insertMany(
      Array.from({ length: 1000 }, (_, index) => ({
        number: `SUB-LOAD-${batch}-${index}`,
        customerId: customer._id,
        planId: plan._id,
        planSnapshot: { name: plan.name },
        startAt: new Date(),
        nextBillingAt: new Date(Date.now() + 86400_000),
        frequency: 'monthly',
        anchorDay: 1,
        anchorMonth: 1,
        status: 'active',
        subtotalMinor: 10000,
        discountMinor: 0,
        taxMinor: 0,
        totalMinor: 10000,
      })),
    );
    await Invoice.insertMany(
      subs.map((sub, index) => ({
        number: `INV-LOAD-${batch}-${index}`,
        customerId: customer._id,
        subscriptionId: sub._id,
        planId: plan._id,
        planName: plan.name,
        customerSnapshot: { name: customer.name, email: customer.email },
        issuedAt: new Date(),
        dueAt: new Date(),
        subtotalMinor: 10000,
        discountMinor: 0,
        taxMinor: 0,
        totalMinor: 10000,
        paidMinor: 0,
        status: 'confirmed',
      })),
    );
  }
  const token = (await createSession(String(admin._id), config)).accessToken;
  const app = createApp({
    origin: config.origin,
    logger: pino({ level: 'silent' }),
    auth: config,
    cache,
    health: async () => ({
      status: 'ready',
      checks: { database: true, redis: true, transactions: true, worker: true },
    }),
  });
  server = app.listen(4101);
  await new Promise<void>((resolve) => server!.on('listening', resolve));
  const preflight = await fetch('http://localhost:4101/api/analytics/dashboard', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(preflight.status, 200);
  assert.equal((await preflight.json()).data.metrics.totalSubscriptions, 10000);
  const output = path.resolve('tests/performance/results');
  await mkdir(output, { recursive: true });
  const script = path.resolve('tests/performance/api.js');
  console.log(
    'Running k6: 10,000 subscriptions/invoices, 100 concurrent virtual users, 60 seconds, isolated test data.',
  );
  const args = [
    'run',
    '--rm',
    '-e',
    'ACCESS_TOKEN',
    '-e',
    'BASE_URL=http://host.docker.internal:4101',
    '-v',
    `${script}:/scripts/api.js:ro`,
    '-v',
    `${output}:/results`,
    'grafana/k6:latest',
    'run',
    '--summary-export=/results/summary.json',
    '/scripts/api.js',
  ];
  const child = spawn('docker', args, {
    env: { ...process.env, ACCESS_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let report = '';
  child.stdout.on('data', (chunk) => {
    const text = String(chunk);
    report += text;
    process.stdout.write(text);
  });
  child.stderr.on('data', (chunk) => {
    report += String(chunk);
  });
  const code = await new Promise<number>((resolve) =>
    child.on('close', (code) => resolve(code ?? 1)),
  );
  await writeFile(path.join(output, 'report.txt'), report);
  assert.equal(code, 0, 'k6 thresholds failed; inspect tests/performance/results/report.txt');
} finally {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  cache.disconnect();
  assert(dbName.startsWith('subscriptiq_test_'));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

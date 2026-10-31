import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { Queue, Worker } from 'bullmq';
const uri = process.env.MONGODB_URI;
const url = process.env.REDIS_URL;
assert(uri && url, 'Set MONGODB_URI and REDIS_URL in .env');
const connection = new Redis(url, { maxRetriesPerRequest: null });
connection.on('error', () => {});
const name = `infra-check-${randomUUID()}`;
const queue = new Queue(name, { connection });
const worker = new Worker(name, async (job) => ({ echoed: job.data.value }), { connection });
const timeout = setTimeout(() => {
  console.error('Infrastructure check timed out');
  process.exit(1);
}, 30_000);
try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  const collection = mongoose.connection.db!.collection('infrastructure_probes');
  await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  const id = randomUUID();
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await collection.insertOne(
        { probeId: id, expiresAt: new Date(Date.now() + 60_000) },
        { session },
      );
      assert.equal(await collection.countDocuments({ probeId: id }, { session }), 1);
    });
    assert.equal(await collection.countDocuments({ probeId: id }), 1);
    await collection.deleteOne({ probeId: id });
  } finally {
    await session.endSession();
  }
  const job = await queue.add('echo', { value: id });
  const deadline = Date.now() + 10_000;
  while ((await job.getState()) !== 'completed') {
    assert(Date.now() < deadline, 'Queue round trip timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const completed = await queue.getJob(job.id!);
  assert.deepEqual(completed?.returnvalue, { echoed: id });
  console.log('PASS: MongoDB transaction commit and BullMQ producer/worker round trip');
} finally {
  await worker.close(true);
  await queue.obliterate({ force: true });
  await queue.close();
  connection.disconnect();
  await mongoose.disconnect();
  clearTimeout(timeout);
}

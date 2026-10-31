import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { Queue } from 'bullmq';
import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { createApp } from '../../apps/api/src/app.js';
import { createHealthCheck } from '../../apps/api/src/services/health.js';
import { startJobSystem, queueNames } from '../../apps/api/src/runtime.js';
const dbName = `subscriptiq_test_browser_${Date.now()}`;
process.env.NODE_ENV = 'test';
process.env.QUEUE_PREFIX = dbName;
process.env.MAIL_TRANSPORT = 'local';
process.env.MAIL_DIRECTORY = 'test-results/mail';
const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
const logger = pino({ level: 'silent' });
await mongoose.connect(process.env.MONGODB_URI!, { dbName });
await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
const jobs = await startJobSystem(process.env.REDIS_URL!, logger);
const heartbeatKey = `${dbName}:worker:heartbeat`;
await redis.set(heartbeatKey, new Date().toISOString(), 'EX', 300);
const app = createApp({
  origin: 'http://127.0.0.1:5180',
  logger,
  auth: {
    secret: randomBytes(48).toString('hex'),
    origin: 'http://127.0.0.1:5180',
    production: false,
  },
  health: createHealthCheck(redis, heartbeatKey),
});
const server = createServer((req, res) => {
  if (req.url === '/__test_shutdown' && req.method === 'POST') {
    res.statusCode = 202;
    res.end();
    void close();
  } else app(req, res);
}).listen(4100, '127.0.0.1', () => console.log('Isolated browser test API ready'));
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  server.close();
  await jobs.close();
  for (const name of queueNames) {
    const queue = new Queue(name, { connection: redis, prefix: dbName });
    await queue.obliterate({ force: true });
    await queue.close();
  }
  if (!dbName.startsWith('subscriptiq_test_')) throw new Error('Unsafe test database');
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await redis.del(heartbeatKey);
  redis.disconnect();
  process.exit(0);
};
process.on('SIGINT', () => {
  void close();
});
process.on('SIGTERM', () => {
  void close();
});

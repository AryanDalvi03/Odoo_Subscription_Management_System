import { z } from 'zod';
import { pino } from 'pino';
import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { startJobSystem } from '@subscriptiq/api/runtime';
const parsed = z
  .object({
    MONGODB_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\//),
    REDIS_URL: z.url().refine((value) => /^rediss?:/.test(value)),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    QUEUE_PREFIX: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .default('subscriptiq'),
  })
  .safeParse(process.env);
if (!parsed.success) {
  console.error(
    'Invalid worker environment variable names:',
    parsed.error.issues.map((issue) => issue.path.join('.')),
  );
  process.exit(1);
}
const env = parsed.data;
const logger = pino({ level: env.LOG_LEVEL });
const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: null,
  connectTimeout: 5000,
});
redis.on('error', () => logger.error('Worker Redis connection interrupted'));
try {
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000, maxPoolSize: 10 });
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  await redis.connect();
  const jobs = await startJobSystem(env.REDIS_URL, logger);
  const heartbeat = async () => {
    await mongoose.connection.db!.admin().ping();
    await redis.set(`${env.QUEUE_PREFIX}:worker:heartbeat`, new Date().toISOString(), 'EX', 30);
  };
  await heartbeat();
  const timer = setInterval(() => {
    void heartbeat().catch(() => logger.error('Worker heartbeat failed'));
  }, 10_000);
  logger.info('Billing, email and reconciliation workers ready');
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    const deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
    await jobs.close();
    redis.disconnect();
    await mongoose.disconnect();
    clearTimeout(deadline);
    process.exit(0);
  };
  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });
} catch {
  logger.error('Worker startup failed: verify MongoDB and Redis');
  redis.disconnect();
  await mongoose.disconnect();
  process.exit(1);
}

import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import type { Env } from './env.js';
export async function connectServices(env: Env) {
  const redis = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    commandTimeout: 3000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 3000),
  });
  redis.on('error', () => {}); // Readiness reports outages without logging connection secrets.
  try {
    await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000, maxPoolSize: 20 });
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
    await redis.connect();
    return {
      redis,
      close: async () => {
        redis.disconnect();
        await mongoose.disconnect();
      },
    };
  } catch (error) {
    redis.disconnect();
    await mongoose.disconnect();
    throw error;
  }
}

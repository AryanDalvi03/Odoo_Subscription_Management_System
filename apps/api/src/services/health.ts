import mongoose from 'mongoose';
import type { Redis } from 'ioredis';
import type { ServiceHealth } from '@subscriptiq/contracts';
export function createHealthCheck(redis: Redis, heartbeatKey = 'subscriptiq:worker:heartbeat') {
  return async (): Promise<ServiceHealth> => {
    const [mongo, cache, heartbeat] = await Promise.allSettled([
      mongoose.connection.db?.admin().command({ hello: 1 }),
      redis.ping(),
      redis.get(heartbeatKey),
    ]);
    const database = mongo.status === 'fulfilled' && Boolean(mongo.value);
    const transactions =
      database &&
      mongo.status === 'fulfilled' &&
      Boolean(mongo.value?.setName || mongo.value?.msg === 'isdbgrid');
    const redisReady = cache.status === 'fulfilled' && cache.value === 'PONG';
    const worker = heartbeat.status === 'fulfilled' && heartbeat.value !== null;
    const checks = { database, redis: redisReady, transactions, worker };
    return { status: Object.values(checks).every(Boolean) ? 'ready' : 'unavailable', checks };
  };
}

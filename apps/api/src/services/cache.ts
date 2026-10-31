import type { Redis } from 'ioredis';
import type { Actor } from './context.js';
import { resourceScope } from './context.js';
import { hashToken } from '../modules/auth/service.js';
const pending = new Map<string, Promise<unknown>>();
export async function cachedAnalytics<T>(
  redis: Redis | undefined,
  actor: Actor,
  input: unknown,
  compute: () => Promise<T>,
): Promise<T> {
  if (!redis) return compute();
  try {
    const [revision, scope] = await Promise.all([
      redis.get(`${process.env.QUEUE_PREFIX ?? 'subscriptiq'}:analytics:revision`),
      resourceScope(actor),
    ]);
    const key = `${process.env.QUEUE_PREFIX ?? 'subscriptiq'}:analytics:${actor.id}:${hashToken(JSON.stringify({ revision, scope, role: actor.role, permissions: actor.permissions, input }))}`;
    const existing = await redis.get(key);
    if (existing) return JSON.parse(existing) as T;
    let calculation = pending.get(key) as Promise<T> | undefined;
    if (!calculation) {
      calculation = compute()
        .then(async (data) => {
          await redis.set(key, JSON.stringify(data), 'EX', 10).catch(() => {});
          return data;
        })
        .finally(() => pending.delete(key));
      pending.set(key, calculation);
    }
    return calculation;
  } catch {
    return compute();
  }
}

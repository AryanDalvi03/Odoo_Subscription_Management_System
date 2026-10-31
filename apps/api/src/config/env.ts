import { z } from 'zod';
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  WEB_ORIGIN: z.url().default('http://localhost:5173'),
  MONGODB_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\//),
  REDIS_URL: z.url().refine((value) => /^rediss?:/.test(value)),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  AUTH_SECRET: z.string().min(48),
  QUEUE_PREFIX: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default('subscriptiq'),
  COOKIE_SAME_SITE: z.enum(['strict', 'lax', 'none']).default('strict'),
});
export type Env = z.infer<typeof envSchema>;

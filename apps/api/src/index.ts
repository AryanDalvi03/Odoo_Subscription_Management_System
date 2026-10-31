import { pino } from 'pino';
import { envSchema } from './config/env.js';
import { connectServices } from './config/connections.js';
import { createHealthCheck } from './services/health.js';
import { createApp } from './app.js';
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error(
    'Invalid environment variable names:',
    parsed.error.issues.map((issue) => issue.path.join('.')),
  );
  process.exit(1);
}
const env = parsed.data;
const logger = pino({ level: env.LOG_LEVEL });
try {
  const services = await connectServices(env);
  const app = createApp({
    origin: env.WEB_ORIGIN,
    logger,
    health: createHealthCheck(services.redis, `${env.QUEUE_PREFIX}:worker:heartbeat`),
    cache: services.redis,
    trustProxyHops: env.TRUST_PROXY_HOPS,
    auth: {
      secret: env.AUTH_SECRET,
      origin: env.WEB_ORIGIN,
      production: env.NODE_ENV === 'production',
      cookieSameSite: env.COOKIE_SAME_SITE,
    },
  });
  const server = app.listen(env.PORT, () =>
    logger.info({ port: env.PORT }, 'SubscriptIQ API listening'),
  );
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const timer = setTimeout(() => process.exit(1), 10_000);
    timer.unref();
    server.close(() => {
      void services.close().then(() => {
        clearTimeout(timer);
        process.exit(0);
      });
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch {
  logger.error('Startup failed: verify MongoDB replica set and Redis connectivity');
  process.exit(1);
}

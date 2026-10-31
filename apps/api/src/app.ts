import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import type { ServiceHealth } from '@subscriptiq/contracts';
import cookieParser from 'cookie-parser';
import { ZodError } from 'zod';
import { AppError } from './lib/errors.js';
import { authRoutes } from './modules/auth/routes.js';
import type { AuthConfig } from './modules/auth/service.js';
import { catalogRoutes } from './modules/catalog/routes.js';
import { subscriptionRoutes } from './modules/subscriptions/routes.js';
import { invoiceRoutes } from './modules/invoices/routes.js';
import { paymentRoutes, razorpayWebhook } from './modules/payments/routes.js';
import { analyticsRoutes } from './modules/analytics/routes.js';
import { operationRoutes } from './modules/operations/routes.js';
import swaggerUi from 'swagger-ui-express';
import { openapi } from './openapi.js';
import { captureFailure } from './config/telemetry.js';
import type { Redis } from 'ioredis';
export function createApp(options: {
  origin: string;
  logger: Logger;
  health: () => Promise<ServiceHealth>;
  auth?: AuthConfig;
  cache?: Redis;
  trustProxyHops?: number;
}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', options.trustProxyHops ?? 0);
  app.use(helmet());
  app.use(cors({ origin: options.origin, credentials: true }));
  app.use(
    pinoHttp({
      logger: options.logger,
      genReqId: () => randomUUID(),
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url?.split('?')[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use((req, res, next) => {
    res.setHeader('X-Request-Id', String(req.id));
    next();
  });
  app.get('/api/health/live', (_req, res) => res.json({ data: { status: 'alive' } }));
  app.get('/api/health/ready', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const health = await options.health();
    res.status(health.status === 'ready' ? 200 : 503).json({ data: health });
  });
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 10000,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (req, res) =>
        res.status(429).json({
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests',
            requestId: String(req.id),
          },
        }),
    }),
  );
  app.post(
    '/api/webhooks/razorpay',
    express.raw({ type: 'application/json', limit: '256kb' }),
    razorpayWebhook,
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body) => {
      if (
        options.cache &&
        !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        !req.path.startsWith('/api/auth') &&
        res.statusCode < 400
      ) {
        void options.cache
          .incr(`${process.env.QUEUE_PREFIX ?? 'subscriptiq'}:analytics:revision`)
          .catch(() => {})
          .finally(() => json(body));
        return res;
      }
      return json(body);
    };
    next();
  });
  app.get('/api/openapi.json', (_req, res) => res.json(openapi));
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(openapi, { customSiteTitle: 'SubscriptIQ API' }),
  );
  if (options.auth) app.use('/api/auth', authRoutes(options.auth));
  if (options.auth) app.use('/api', catalogRoutes(options.auth));
  if (options.auth) app.use('/api', subscriptionRoutes(options.auth));
  if (options.auth) app.use('/api', invoiceRoutes(options.auth));
  if (options.auth) app.use('/api', paymentRoutes(options.auth));
  if (options.auth) app.use('/api', analyticsRoutes(options.auth, options.cache));
  if (options.auth) app.use('/api', operationRoutes(options.auth));
  app.use((req, res) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Resource not found', requestId: String(req.id) },
    });
  });
  const errors: ErrorRequestHandler = (error, req, res, _next) => {
    const malformed = error instanceof SyntaxError && 'body' in error;
    const tooLarge = error?.type === 'entity.too.large';
    const validation = error instanceof ZodError;
    const status =
      error instanceof AppError
        ? error.status
        : tooLarge
          ? 413
          : validation
            ? 422
            : malformed
              ? 400
              : error?.code === 11000
                ? 409
                : 500;
    if (status === 500) captureFailure(error);
    req.log.error(
      { errorType: error instanceof Error ? error.name : 'UnknownError' },
      'Request failed',
    );
    res.status(status).json({
      error: {
        code:
          error instanceof AppError
            ? error.code
            : tooLarge
              ? 'PAYLOAD_TOO_LARGE'
              : validation
                ? 'VALIDATION_ERROR'
                : malformed
                  ? 'INVALID_JSON'
                  : status === 409
                    ? 'CONFLICT'
                    : 'INTERNAL_ERROR',
        message:
          error instanceof AppError
            ? error.message
            : tooLarge
              ? 'Request body exceeds the allowed size'
              : validation
                ? 'Please check the supplied fields'
                : malformed
                  ? 'Malformed JSON body'
                  : status === 409
                    ? 'This record already exists'
                    : 'An unexpected error occurred',
        ...(validation ? { fieldErrors: error.flatten().fieldErrors } : {}),
        requestId: String(req.id),
      },
    });
  };
  app.use(errors);
  return app;
}

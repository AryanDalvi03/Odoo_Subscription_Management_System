import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { User, Session, SystemSetting } from '../../models/index.js';
import mongoose from 'mongoose';
import argon2 from 'argon2';
import { ensure } from '../../lib/errors.js';
import * as auth from './service.js';
export function authRoutes(config: auth.AuthConfig) {
  const router = Router();
  const limited = rateLimit({
    windowMs: 15 * 60_000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) =>
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many authentication attempts. Please try again later.',
          requestId: String(req.id),
        },
      }),
  });
  const cookie = {
    httpOnly: true,
    secure: config.production,
    sameSite: config.cookieSameSite ?? ('strict' as const),
    path: '/api/auth',
    maxAge: 7 * 86400_000,
  };
  const csrf = (req: Request) =>
    ensure(
      req.get('origin') === config.origin || (!config.production && !req.get('origin')),
      403,
      'INVALID_ORIGIN',
      'Request origin is not permitted',
    );
  router.get('/setup-status', async (_req, res) =>
    res.json({ data: { required: !(await User.exists({ role: 'admin' })) } }),
  );
  router.post('/setup', limited, async (req, res) => {
    csrf(req);
    const body = z
      .object({
        name: z.string().trim().min(2).max(100),
        email: auth.emailSchema,
        password: auth.passwordSchema,
        setupToken: z.string().optional(),
      })
      .strict()
      .parse(req.body);
    if (config.production)
      ensure(
        process.env.SETUP_TOKEN &&
          body.setupToken &&
          auth.hashToken(body.setupToken) === auth.hashToken(process.env.SETUP_TOKEN),
        403,
        'SETUP_TOKEN_REQUIRED',
        'Enter the server setup token',
      );
    else
      ensure(
        ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip ?? ''),
        403,
        'LOCAL_SETUP_ONLY',
        'Initial setup is allowed only from this computer',
      );
    const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
    await mongoose.connection.transaction(async (session) => {
      ensure(
        !(await User.exists({ role: 'admin' }).session(session)),
        409,
        'ALREADY_CONFIGURED',
        'An administrator already exists',
      );
      await SystemSetting.create([{ key: 'bootstrap-complete', value: true }], { session });
      await User.create(
        [
          {
            name: body.name,
            email: body.email,
            passwordHash,
            role: 'admin',
            verifiedAt: new Date(),
          },
        ],
        { session },
      );
    });
    const result = await auth.login(body.email, body.password, config);
    res
      .cookie('refresh', result.refreshToken, cookie)
      .status(201)
      .json({ data: { user: result.user, accessToken: result.accessToken } });
  });
  router.post('/register', limited, async (req, res) => {
    const body = z
      .object({
        name: z.string().trim().min(2).max(100),
        email: auth.emailSchema,
        password: auth.passwordSchema,
      })
      .strict()
      .parse(req.body);
    await auth.register(body, config);
    res.status(201).json({ data: { message: 'Check your email to verify your account.' } });
  });
  router.post('/login', limited, async (req, res) => {
    const body = z
      .object({ email: auth.emailSchema, password: z.string().max(128) })
      .strict()
      .parse(req.body);
    const result = await auth.login(body.email, body.password, config);
    res
      .cookie('refresh', result.refreshToken, cookie)
      .json({ data: { user: result.user, accessToken: result.accessToken } });
  });
  router.post('/refresh', async (req, res) => {
    csrf(req);
    ensure(req.cookies?.refresh, 401, 'SESSION_EXPIRED', 'Please sign in');
    const result = await auth.refresh(req.cookies.refresh, config);
    res
      .cookie('refresh', result.refreshToken, cookie)
      .json({ data: { user: result.user, accessToken: result.accessToken } });
  });
  router.post('/logout', async (req, res) => {
    csrf(req);
    if (req.cookies?.refresh)
      await Session.updateOne(
        { tokenHash: auth.hashToken(req.cookies.refresh) },
        { revokedAt: new Date() },
      );
    res
      .clearCookie('refresh', { ...cookie, maxAge: undefined })
      .status(204)
      .end();
  });
  router.post('/logout-all', async (req, res) => {
    csrf(req);
    const actor = await auth.authenticate(req.get('authorization'), config);
    await Session.updateMany({ userId: actor.id }, { revokedAt: new Date() });
    res
      .clearCookie('refresh', { ...cookie, maxAge: undefined })
      .status(204)
      .end();
  });
  router.get('/me', async (req, res) => {
    res.json({ data: await auth.authenticate(req.get('authorization'), config) });
  });
  for (const [route, purpose] of [
    ['forgot-password', 'reset'],
    ['resend-verification', 'verify'],
  ] as const)
    router.post(`/${route}`, limited, async (req, res) => {
      const { email } = z.object({ email: auth.emailSchema }).strict().parse(req.body);
      const user = await User.findOne({ email, active: true });
      if (user && (purpose === 'reset' || !user.verifiedAt))
        await auth.issueAuthToken(String(user._id), email, purpose, config);
      res.json({ data: { message: 'If the account is eligible, an email will be sent.' } });
    });
  router.post('/verify-email', limited, async (req, res) => {
    const { token } = z
      .object({ token: z.string().length(64) })
      .strict()
      .parse(req.body);
    await auth.consumeToken(token, 'verify', config);
    res.json({ data: { message: 'Email verified. You can sign in.' } });
  });
  router.post('/reset-password', limited, async (req, res) => {
    const { token, password } = z
      .object({ token: z.string().length(64), password: auth.passwordSchema })
      .strict()
      .parse(req.body);
    await auth.consumeToken(token, 'reset', config, password);
    res.json({ data: { message: 'Password reset. Please sign in.' } });
  });
  return router;
}

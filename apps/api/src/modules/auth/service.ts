import { createHash, randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { z } from 'zod';
import { User, Customer, Session, AuthToken } from '../../models/index.js';
import { ensure } from '../../lib/errors.js';
import { audit, notify, type Actor } from '../../services/context.js';
export const passwordSchema = z
  .string()
  .min(9)
  .max(128)
  .regex(/[A-Z]/, 'Include an uppercase letter')
  .regex(/[a-z]/, 'Include a lowercase letter')
  .regex(/[^A-Za-z0-9]/, 'Include a special character');
export const emailSchema = z
  .email()
  .max(254)
  .transform((value) => value.trim().toLowerCase());
export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
export type AuthConfig = {
  secret: string;
  origin: string;
  production: boolean;
  cookieSameSite?: 'strict' | 'lax' | 'none';
};
export function publicUser(user: {
  _id: unknown;
  name: string;
  email: string;
  role: string;
  permissions: string[];
}) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    permissions: user.permissions,
  };
}
export async function issueAuthToken(
  userId: string,
  email: string,
  purpose: 'verify' | 'reset',
  config: AuthConfig,
  session?: mongoose.ClientSession,
) {
  const token = randomBytes(32).toString('hex');
  await AuthToken.create(
    [
      {
        userId,
        tokenHash: hashToken(token),
        purpose,
        expiresAt: new Date(Date.now() + (purpose === 'reset' ? 30 : 1440) * 60_000),
      },
    ],
    { session },
  );
  const link = `${config.origin}/${purpose === 'verify' ? 'verify-email' : 'reset-password'}?token=${token}`;
  await notify(
    email,
    purpose === 'verify' ? 'Verify your SubscriptIQ email' : 'Reset your SubscriptIQ password',
    `Open this single-use link: ${link}`,
    `auth-${randomUUID()}`,
    session,
  );
}
export async function register(
  input: { name: string; email: string; password: string },
  config: AuthConfig,
) {
  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
  await mongoose.connection.transaction(async (session) => {
    ensure(
      !(await User.exists({ email: input.email }).session(session)),
      409,
      'EMAIL_EXISTS',
      'An account with this email already exists',
    );
    const [user] = await User.create(
      [{ name: input.name, email: input.email, passwordHash, role: 'customer' }],
      { session },
    );
    await Customer.create([{ userId: user!._id, name: input.name, email: input.email }], {
      session,
    });
    await issueAuthToken(String(user!._id), input.email, 'verify', config, session);
    await audit(undefined, 'registered', 'User', user!._id, { role: 'customer' }, session);
  });
}
export async function createSession(
  userId: string,
  config: AuthConfig,
  family: string = randomUUID(),
  transaction?: mongoose.ClientSession,
) {
  const refreshToken = randomBytes(48).toString('hex');
  const [session] = await Session.create(
    [
      {
        userId,
        tokenHash: hashToken(refreshToken),
        family,
        expiresAt: new Date(Date.now() + 7 * 86400_000),
      },
    ],
    { session: transaction },
  );
  return {
    accessToken: jwt.sign({ sub: userId, sid: String(session!._id) }, config.secret, {
      expiresIn: '15m',
      issuer: 'subscriptiq',
      audience: 'subscriptiq-web',
      algorithm: 'HS256',
    }),
    refreshToken,
  };
}
export async function login(email: string, password: string, config: AuthConfig) {
  const user = await User.findOne({ email }).select('+passwordHash');
  // Always run Argon2 to reduce the account-enumeration timing difference.
  const fallback =
    '$argon2id$v=19$m=65536,t=3,p=4$YWFhYWFhYWFhYWFhYWFhYQ$MnqS+OuFQeunJNgA0URgHLzANEC2zsQbLwH7tXoR4Vk';
  const valid = await argon2.verify(user?.passwordHash ?? fallback, password).catch(() => false);
  ensure(user && valid && user.active, 401, 'INVALID_LOGIN', 'Invalid email or password');
  ensure(user.verifiedAt, 403, 'EMAIL_UNVERIFIED', 'Verify your email before signing in');
  return { user: publicUser(user), ...(await createSession(String(user._id), config)) };
}
export async function refresh(token: string, config: AuthConfig) {
  const result = await mongoose.connection.transaction(async (transaction) => {
    const existing = await Session.findOne({ tokenHash: hashToken(token) }).session(transaction);
    ensure(existing && existing.expiresAt > new Date(), 401, 'SESSION_EXPIRED', 'Session expired');
    if (existing.revokedAt) {
      await Session.updateMany(
        { family: existing.family },
        { revokedAt: new Date() },
        { session: transaction },
      );
      return { replay: true as const };
    }
    existing.revokedAt = new Date();
    await existing.save({ session: transaction });
    const user = await User.findById(existing.userId).session(transaction);
    ensure(user?.active && user.verifiedAt, 401, 'SESSION_EXPIRED', 'Session expired');
    return {
      replay: false as const,
      user: publicUser(user),
      ...(await createSession(String(user._id), config, existing.family, transaction)),
    };
  });
  ensure(!result.replay, 401, 'TOKEN_REPLAY', 'Session reuse detected; please sign in again');
  return result;
}
export async function consumeToken(
  token: string,
  purpose: 'verify' | 'reset',
  config: AuthConfig,
  password?: string,
) {
  const passwordHash = password
    ? await argon2.hash(password, { type: argon2.argon2id })
    : undefined;
  await mongoose.connection.transaction(async (session) => {
    const record = await AuthToken.findOneAndUpdate(
      {
        tokenHash: hashToken(token),
        purpose,
        usedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
      },
      { usedAt: new Date() },
      { session },
    );
    ensure(record, 400, 'INVALID_TOKEN', 'Link is invalid or expired');
    if (purpose === 'verify')
      await User.updateOne({ _id: record.userId }, { verifiedAt: new Date() }, { session });
    else {
      await User.updateOne({ _id: record.userId }, { passwordHash }, { session });
      await Session.updateMany({ userId: record.userId }, { revokedAt: new Date() }, { session });
    }
    await AuthToken.updateMany(
      { userId: record.userId, purpose, usedAt: { $exists: false } },
      { usedAt: new Date() },
      { session },
    );
    await audit(
      undefined,
      purpose === 'verify' ? 'email_verified' : 'password_reset',
      'User',
      record.userId,
      undefined,
      session,
    );
  });
}
export async function authenticate(header: string | undefined, config: AuthConfig): Promise<Actor> {
  ensure(
    typeof header === 'string' && header.startsWith('Bearer '),
    401,
    'UNAUTHENTICATED',
    'Please sign in',
  );
  let id: string;
  try {
    const payload = jwt.verify(header.slice(7), config.secret, {
      algorithms: ['HS256'],
      issuer: 'subscriptiq',
      audience: 'subscriptiq-web',
    });
    ensure(
      typeof payload !== 'string' &&
        typeof payload.sub === 'string' &&
        typeof payload.sid === 'string',
      401,
      'INVALID_TOKEN',
      'Invalid token',
    );
    id = payload.sub;
    ensure(
      await Session.exists({
        _id: payload.sid,
        userId: id,
        revokedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
      }),
      401,
      'SESSION_EXPIRED',
      'Session expired',
    );
  } catch {
    ensure(false, 401, 'INVALID_TOKEN', 'Your session has expired');
  }
  const user = await User.findById(id!);
  ensure(user?.active && user.verifiedAt, 401, 'UNAUTHENTICATED', 'Please sign in');
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role as Actor['role'],
    permissions: user.permissions,
  };
}

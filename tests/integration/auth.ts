import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import { pino } from 'pino';
import { createApp } from '../../apps/api/src/app.js';
import { User, Notification, Customer } from '../../apps/api/src/models/index.js';
const dbName = `subscriptiq_test_auth_${Date.now()}`;
await mongoose.connect(process.env.MONGODB_URI!, { dbName });
try {
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  const config = {
    secret: randomBytes(48).toString('hex'),
    origin: 'http://localhost:5173',
    production: false,
  };
  const app = createApp({
    origin: config.origin,
    logger: pino({ level: 'silent' }),
    auth: config,
    health: async () => ({
      status: 'ready',
      checks: { database: true, redis: true, transactions: true, worker: true },
    }),
  });
  const account = {
    name: 'Test Customer',
    email: 'customer@example.test',
    password: randomBytes(12).toString('hex') + 'Aa!',
  };
  assert.equal(
    (
      await request(app)
        .post('/api/auth/register')
        .send({ ...account, role: 'admin' })
    ).status,
    422,
  );
  assert.equal(
    (
      await request(app)
        .post('/api/auth/register')
        .send({ ...account, password: 'short' })
    ).status,
    422,
  );
  assert.equal((await request(app).post('/api/auth/register').send(account)).status, 201);
  assert.equal((await request(app).post('/api/auth/register').send(account)).status, 409);
  assert.equal(
    (await request(app).post('/api/auth/login').send({ email: account.email, password: 'wrong' }))
      .status,
    401,
  );
  assert.equal((await request(app).post('/api/auth/login').send(account)).status, 422);
  assert.equal(
    (
      await request(app)
        .post('/api/auth/login')
        .send({ email: account.email, password: account.password })
    ).status,
    403,
  );
  const notification = await Notification.findOne({ recipient: account.email });
  const token = new URL(notification!.text.split(' ').at(-1)!).searchParams.get('token');
  assert.equal((await request(app).post('/api/auth/verify-email').send({ token })).status, 200);
  assert.equal((await request(app).post('/api/auth/verify-email').send({ token })).status, 400);
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: account.email, password: account.password });
  assert.equal(login.status, 200);
  assert.equal(login.body.data.user.role, 'customer');
  assert.equal(await Customer.countDocuments(), 1);
  const access = login.body.data.accessToken;
  const cookie = login.headers['set-cookie']![0]!.split(';')[0]!;
  assert.equal(
    (await request(app).get('/api/auth/me').set('Authorization', `Bearer ${access}`)).status,
    200,
  );
  assert.equal(
    (
      await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookie)
        .set('Origin', 'https://evil.example')
    ).status,
    403,
  );
  const refreshed = await request(app)
    .post('/api/auth/refresh')
    .set('Cookie', cookie)
    .set('Origin', config.origin);
  assert.equal(refreshed.status, 200);
  assert.equal(
    (await request(app).get('/api/auth/me').set('Authorization', `Bearer ${access}`)).status,
    401,
  );
  assert.equal((await request(app).post('/api/auth/refresh').set('Cookie', cookie)).status, 401);
  assert.equal(
    (
      await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${refreshed.body.data.accessToken}`)
    ).status,
    401,
  );
  const beforeReset = await request(app)
    .post('/api/auth/login')
    .send({ email: account.email, password: account.password });
  assert.equal(beforeReset.status, 200);
  assert.equal(
    (await request(app).post('/api/auth/forgot-password').send({ email: account.email })).status,
    200,
  );
  const resetNotice = await Notification.findOne({
    recipient: account.email,
    subject: 'Reset your SubscriptIQ password',
  }).sort('-createdAt');
  const resetToken = new URL(resetNotice!.text.split(' ').at(-1)!).searchParams.get('token');
  const newPassword = randomBytes(12).toString('hex') + 'Bb!';
  assert.equal(
    (
      await request(app)
        .post('/api/auth/reset-password')
        .send({ token: resetToken, password: newPassword })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(app)
        .post('/api/auth/reset-password')
        .send({ token: resetToken, password: newPassword })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${beforeReset.body.data.accessToken}`)
    ).status,
    401,
  );
  assert.equal(
    (
      await request(app)
        .post('/api/auth/login')
        .send({ email: account.email, password: newPassword })
    ).status,
    200,
  );
  const stored = await User.findOne({ email: account.email }).select('+passwordHash');
  assert(stored!.passwordHash.startsWith('$argon2id$'));
  assert.notEqual(stored!.passwordHash, account.password);
  console.log(
    'PASS auth: registration validation, duplicate email, unverified/invalid login, verification replay, JWT session binding, refresh rotation/replay, origin rejection and Argon2 storage',
  );
} finally {
  assert(dbName.startsWith('subscriptiq_test_'));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

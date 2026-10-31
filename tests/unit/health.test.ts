import { test, expect } from '@jest/globals';
import request from 'supertest';
import { pino } from 'pino';
import { createApp } from '../../apps/api/src/app.js';
import { envSchema } from '../../apps/api/src/config/env.js';
const checks = { database: true, redis: true, transactions: true, worker: true };
const app = createApp({
  origin: 'http://localhost:5173',
  logger: pino({ level: 'silent' }),
  health: async () => ({ status: 'ready', checks }),
});
test('liveness does not depend on infrastructure and emits security/request headers', async () => {
  const response = await request(app).get('/api/health/live');
  expect(response.status).toBe(200);
  expect(response.body.data.status).toBe('alive');
  expect(response.headers['x-request-id']).toBeTruthy();
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['x-powered-by']).toBeUndefined();
});
test('readiness returns dependency result and is not cached', async () => {
  const response = await request(app).get('/api/health/ready');
  expect(response.status).toBe(200);
  expect(response.body.data.checks).toEqual(checks);
  expect(response.headers['cache-control']).toBe('no-store');
  const unavailable = createApp({
    origin: 'http://localhost:5173',
    logger: pino({ level: 'silent' }),
    health: async () => ({ status: 'unavailable', checks: { ...checks, transactions: false } }),
  });
  expect((await request(unavailable).get('/api/health/ready')).status).toBe(503);
});
test('unknown routes return consistent errors without stack traces', async () => {
  const response = await request(app).get('/api/missing');
  expect(response.status).toBe(404);
  expect(response.body.error).toEqual({
    code: 'NOT_FOUND',
    message: 'Resource not found',
    requestId: expect.any(String),
  });
});
test('malformed JSON returns 400', async () => {
  expect(
    (await request(app).post('/api/missing').set('Content-Type', 'application/json').send('{'))
      .status,
  ).toBe(400);
  const oversized = await request(app)
    .post('/api/missing')
    .send({ value: 'x'.repeat(110000) });
  expect(oversized.status).toBe(413);
  expect(oversized.body.error.code).toBe('PAYLOAD_TOO_LARGE');
});
test('invalid environment fails validation', () => {
  expect(
    envSchema.safeParse({ MONGODB_URI: 'https://bad', REDIS_URL: 'https://bad', PORT: 0 }).success,
  ).toBe(false);
});

import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import { pino } from 'pino';
import { createApp } from '../../apps/api/src/app.js';
import { User, Customer } from '../../apps/api/src/models/index.js';
import { createSession } from '../../apps/api/src/modules/auth/service.js';
import { pricePlan } from '../../apps/api/src/services/pricing.js';
const dbName = `subscriptiq_test_catalog_${Date.now()}`;
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
  const admin = await User.create({
    name: 'Admin',
    email: 'admin@example.test',
    role: 'admin',
    passwordHash: 'test-only',
    verifiedAt: new Date(),
  });
  const staff = await User.create({
    name: 'Staff',
    email: 'staff@example.test',
    role: 'staff',
    passwordHash: 'test-only',
    verifiedAt: new Date(),
    permissions: ['customers:read'],
  });
  const buyer = await User.create({
    name: 'Buyer',
    email: 'buyer@example.test',
    role: 'customer',
    passwordHash: 'test-only',
    verifiedAt: new Date(),
  });
  const token = (await createSession(String(admin._id), config)).accessToken;
  const customerToken = (await createSession(String(buyer._id), config)).accessToken;
  const staffToken = (await createSession(String(staff._id), config)).accessToken;
  const product = { name: 'Accounting', salesPriceMinor: 100000, costPriceMinor: 20000 };
  assert.equal(
    (
      await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${customerToken}`)
        .send(product)
    ).status,
    403,
  );
  const p = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${token}`)
    .send(product);
  assert.equal(p.status, 201);
  assert.equal(
    (
      await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...product, salesPriceMinor: 1.2 })
    ).status,
    422,
  );
  const v = await request(app)
    .post(`/api/products/${p.body.data._id}/variants`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Odoo', additionalPriceMinor: 56000 });
  assert.equal(v.status, 201);
  const plan = await request(app)
    .post('/api/plans')
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: 'Monthly Accounting',
      products: [{ productId: p.body.data._id, unitPriceMinor: 100000 }],
      frequency: 'monthly',
      minQuantity: 2,
    });
  assert.equal(plan.status, 201);
  const priced = await pricePlan(plan.body.data._id, 2, { [p.body.data._id]: v.body.data._id });
  assert.equal(priced.totalMinor, 312000);
  await assert.rejects(() => pricePlan(plan.body.data._id, 1));
  const own = await Customer.create({ userId: buyer._id, name: 'Buyer', email: buyer.email });
  const other = await Customer.create({ name: 'Other', email: 'other@example.test' });
  assert.equal(
    (
      await request(app)
        .get(`/api/customers/${other._id}`)
        .set('Authorization', `Bearer ${customerToken}`)
    ).status,
    404,
  );
  assert.equal(
    (await request(app).get('/api/customers').set('Authorization', `Bearer ${customerToken}`)).body
      .data.length,
    1,
  );
  assert.equal(
    (await request(app).get('/api/customers').set('Authorization', `Bearer ${staffToken}`)).body
      .data.length,
    0,
  );
  await Customer.updateOne({ _id: own._id }, { assignedStaffIds: [staff._id] });
  assert.equal(
    (await request(app).get('/api/customers').set('Authorization', `Bearer ${staffToken}`)).body
      .data.length,
    1,
  );
  assert.equal(
    (await request(app).get('/api/staff').set('Authorization', `Bearer ${staffToken}`)).status,
    403,
  );
  const visible = await request(app)
    .get('/api/products')
    .set('Authorization', `Bearer ${customerToken}`);
  assert.equal(visible.body.data[0].costPriceMinor, undefined);
  assert.equal(
    (
      await request(app)
        .delete(`/api/products/${p.body.data._id}`)
        .set('Authorization', `Bearer ${token}`)
    ).status,
    204,
  );
  const archived = await request(app)
    .get(`/api/products/${p.body.data._id}`)
    .set('Authorization', `Bearer ${token}`);
  const edited = await request(app)
    .patch(`/api/products/${p.body.data._id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('If-Match', String(archived.body.data.__v))
    .send({ ...product, name: 'Archived accounting' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.data.status, 'archived');
  console.log(
    'PASS catalog: admin guards, price validation, plan minimums, variant calculation, staff assignment/customer isolation and private pricing fields',
  );
} finally {
  assert(dbName.startsWith('subscriptiq_test_'));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

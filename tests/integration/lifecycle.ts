import 'dotenv/config';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  User,
  Customer,
  Product,
  Plan,
  Tax,
  Discount,
  Invoice,
  Subscription,
  BillingRecord,
  DiscountUsage,
} from '../../apps/api/src/models/index.js';
import {
  createQuotation,
  quotationAction,
  convertQuotation,
  subscriptionAction,
} from '../../apps/api/src/modules/subscriptions/service.js';
import { previewInvoice, cancelInvoice } from '../../apps/api/src/modules/invoices/service.js';
import { billCycle } from '../../apps/api/src/modules/billing/service.js';
import { priceLines } from '../../apps/api/src/services/pricing.js';
import type { Actor } from '../../apps/api/src/services/context.js';
const dbName = `subscriptiq_test_lifecycle_${Date.now()}`;
await mongoose.connect(process.env.MONGODB_URI!, { dbName });
try {
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  const admin = await User.create({
    name: 'Admin',
    email: 'admin@example.test',
    passwordHash: 'test-only',
    role: 'admin',
    verifiedAt: new Date(),
  });
  const actor: Actor = {
    id: String(admin._id),
    name: admin.name,
    email: admin.email,
    role: 'admin',
    permissions: [],
  };
  const customer = await Customer.create({
    name: 'Lifecycle customer',
    email: 'customer@example.test',
  });
  const product = await Product.create({
    name: 'Accounting',
    salesPriceMinor: 100000,
    costPriceMinor: 20000,
  });
  const plan = await Plan.create({
    name: 'Monthly',
    products: [{ productId: product._id, unitPriceMinor: 100000 }],
    frequency: 'monthly',
    minQuantity: 1,
    allowPause: true,
  });
  const tax = await Tax.create({
    name: 'Tax',
    rateBps: 1800,
    effectiveFrom: new Date('2020-01-01'),
  });
  const discount = await Discount.create({
    name: 'One redemption',
    kind: 'percentage',
    value: 1000,
    startAt: new Date('2020-01-01'),
    endAt: new Date('2099-01-01'),
    maxRedemptions: 1,
  });
  const quote = await createQuotation(actor, {
    customerId: String(customer._id),
    planId: String(plan._id),
    quantity: 1,
    expiryAt: new Date(Date.now() + 86400_000),
    variants: {},
    terms: 'Test terms',
  });
  await assert.rejects(() => convertQuotation(actor, String(quote._id)));
  await quotationAction(actor, String(quote._id), 'send');
  await quotationAction(actor, String(quote._id), 'accept');
  const sub = await convertQuotation(actor, String(quote._id));
  assert(sub);
  assert.equal(String((await convertQuotation(actor, String(quote._id)))!._id), String(sub._id));
  await assert.rejects(() => subscriptionAction(actor, String(sub._id), 'resume', 'invalid'));
  await subscriptionAction(actor, String(sub._id), 'activate', 'test');
  const current = await Subscription.findById(sub._id);
  const cycle = current!.nextBillingAt;
  const preview = await previewInvoice(actor, String(sub._id));
  assert.equal(preview.status, 'draft');
  assert.equal(String((await previewInvoice(actor, String(sub._id)))._id), String(preview._id));
  assert.equal(await BillingRecord.countDocuments(), 0);
  assert.equal(await DiscountUsage.countDocuments(), 0);
  const results = await Promise.all([
    billCycle(String(sub._id), cycle),
    billCycle(String(sub._id), cycle),
  ]);
  assert.equal(String(results[0]), String(results[1]));
  assert.equal(String(results[0]), String(preview._id));
  assert.equal(await Invoice.countDocuments(), 1);
  assert.equal(await BillingRecord.countDocuments(), 1);
  assert.equal(await DiscountUsage.countDocuments(), 1);
  const invoice = await Invoice.findOne();
  assert.equal(invoice!.totalMinor, 106200);
  assert.equal((await Discount.findById(discount._id))!.usedCount, 1);
  await Tax.updateOne({ _id: tax._id }, { rateBps: 500 });
  assert.equal((await Invoice.findById(invoice!._id))!.taxMinor, 16200);
  assert.equal(
    (
      await priceLines(
        [
          {
            productId: String(product._id),
            name: product.name,
            quantity: 1,
            unitPriceMinor: 100000,
          },
        ],
        new Date(),
      )
    ).discountMinor,
    0,
  );
  await subscriptionAction(actor, String(sub._id), 'pause', 'test');
  const pending = await Subscription.findById(sub._id);
  await billCycle(String(sub._id), pending!.nextBillingAt, new Date(pending!.nextBillingAt));
  assert.equal((await Subscription.findById(sub._id))!.status, 'paused');
  assert.equal(await Invoice.countDocuments(), 1);
  await subscriptionAction(actor, String(sub._id), 'resume', 'test');
  assert.equal((await Subscription.findById(sub._id))!.status, 'active');
  const annual = await Plan.create({
    name: 'Annual upgrade',
    products: [{ productId: product._id, unitPriceMinor: 2400000 }],
    frequency: 'yearly',
  });
  const upgradeCycle = new Date('2027-03-15T04:30:00Z');
  await Subscription.updateOne(
    { _id: sub._id },
    { nextBillingAt: upgradeCycle, anchorDay: 15, anchorMonth: 1 },
  );
  await subscriptionAction(actor, String(sub._id), 'upgrade', 'Annual upgrade', String(annual._id));
  await billCycle(String(sub._id), upgradeCycle, upgradeCycle);
  assert.equal(
    (await Subscription.findById(sub._id))!.nextBillingAt.toISOString(),
    '2028-03-15T04:30:00.000Z',
  );
  const scheduled = await Subscription.findById(sub._id);
  const futurePreview = await previewInvoice(actor, String(sub._id));
  await cancelInvoice(actor, String(futurePreview._id), 'Preview withdrawn');
  assert.equal((await Invoice.findById(futurePreview._id))!.status, 'cancelled');
  assert.equal((await Invoice.findById(futurePreview._id))!.cycleKey, undefined);
  assert.equal(
    (await Subscription.findById(sub._id))!.nextBillingAt.getTime(),
    scheduled!.nextBillingAt.getTime(),
  );
  console.log(
    'PASS lifecycle: quotation states/conversion idempotency, transitions, concurrent cycle deduplication, discount usage cap, immutable tax snapshots and pause/resume boundaries',
  );
} finally {
  assert(dbName.startsWith('subscriptiq_test_'));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

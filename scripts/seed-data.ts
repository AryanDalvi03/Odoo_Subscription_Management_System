import 'dotenv/config';
import mongoose from 'mongoose';
import argon2 from 'argon2';
import {
  User,
  Customer,
  Product,
  ProductVariant,
  Plan,
  Tax,
  Discount,
  DiscountUsage,
  QuotationTemplate,
  Quotation,
  Subscription,
  Invoice,
  Payment,
  PaymentAllocation,
  BillingRecord,
  SystemSetting,
  AuditLog,
} from '../apps/api/src/models/index.js';

await mongoose.connect(process.env.MONGODB_URI!);
console.log('Connected to MongoDB replica set.');

// 1. Settings & Bootstrap
await SystemSetting.updateOne(
  { key: 'bootstrap-complete' },
  { $set: { value: true } },
  { upsert: true },
);

await SystemSetting.updateOne(
  { key: 'business' },
  {
    $set: {
      value: {
        companyName: 'Brightloop Software',
        supportEmail: 'billing@brightloop.io',
        taxId: '27AAACB1234F1Z5',
        address: 'Cyber City, Tower B, Pune, Maharashtra 411028, India',
        invoiceFooter:
          'Thank you for choosing Brightloop Software! Subscriptions billed automatically.',
      },
    },
  },
  { upsert: true },
);
console.log('✓ System & Company Settings configured');

// 2. Admin User
const adminPasswordHash = await argon2.hash('BrightloopAdmin!2026', { type: argon2.argon2id });
const adminUser = await User.findOneAndUpdate(
  { email: 'admin@brightloop.io' },
  {
    name: 'Brightloop Admin',
    email: 'admin@brightloop.io',
    passwordHash: adminPasswordHash,
    role: 'admin',
    verifiedAt: new Date(),
    active: true,
    permissions: [],
  },
  { upsert: true, new: true },
);
console.log('✓ Admin user ready: admin@brightloop.io');

// 3. Staff User
const staffPasswordHash = await argon2.hash('BrightloopStaff!2026', { type: argon2.argon2id });
const staffUser = await User.findOneAndUpdate(
  { email: 'staff@brightloop.io' },
  {
    name: 'Priya Sharma (Sales Lead)',
    email: 'staff@brightloop.io',
    passwordHash: staffPasswordHash,
    role: 'staff',
    verifiedAt: new Date(),
    active: true,
    permissions: [
      'customers:read',
      'customers:write',
      'quotations:read',
      'quotations:write',
      'subscriptions:read',
      'subscriptions:write',
      'invoices:read',
      'invoices:write',
      'payments:read',
      'payments:write',
      'reports:read',
    ],
  },
  { upsert: true, new: true },
);
console.log('✓ Staff user ready: staff@brightloop.io');

// 4. Customer User (Abhishek)
const customerUser = await User.findOne({ email: 'abhisheknanaware39@gmail.com' });
if (customerUser) {
  customerUser.verifiedAt = new Date();
  await customerUser.save();
}

const customerAbhishek = await Customer.findOneAndUpdate(
  { email: 'abhisheknanaware39@gmail.com' },
  {
    userId: customerUser?._id,
    name: 'Abhishek Nanaware',
    email: 'abhisheknanaware39@gmail.com',
    company: 'Nanaware Technologies Pvt Ltd',
    phone: '+91 98765 43210',
    address: 'Viman Nagar, Pune, Maharashtra 411014',
    taxId: '27AAAAA0000A1Z5',
    assignedStaffIds: [staffUser._id],
    status: 'active',
  },
  { upsert: true, new: true },
);

const customerAcme = await Customer.findOneAndUpdate(
  { email: 'billing@acmecorp.test' },
  {
    name: 'Acme Global Corp',
    email: 'billing@acmecorp.test',
    company: 'Acme Corporation',
    phone: '+91 91234 56789',
    address: 'BKC, Bandra, Mumbai, Maharashtra 400051',
    taxId: '27ACMEG1234A1Z9',
    assignedStaffIds: [staffUser._id],
    status: 'active',
  },
  { upsert: true, new: true },
);
console.log('✓ Customer accounts ready');

// 5. Products & Variants
const productAccounting = await Product.findOneAndUpdate(
  { name: 'Accounting Software' },
  {
    name: 'Accounting Software',
    type: 'software',
    description: 'Comprehensive double-entry bookkeeping, invoicing, bank sync, and GST returns.',
    salesPriceMinor: 100000, // ₹1,000.00
    costPriceMinor: 20000, // ₹200.00
    notes: 'Core financial product with pluggable ERP brand variants.',
    status: 'active',
  },
  { upsert: true, new: true },
);

const productCRM = await Product.findOneAndUpdate(
  { name: 'CRM & Lead Suite' },
  {
    name: 'CRM & Lead Suite',
    type: 'software',
    description: 'Sales pipelines, customer lifecycle tracking, email sequences, and analytics.',
    salesPriceMinor: 150000, // ₹1,500.00
    costPriceMinor: 35000, // ₹350.00
    notes: 'Scales from single sales reps to corporate teams.',
    status: 'active',
  },
  { upsert: true, new: true },
);

const productInventory = await Product.findOneAndUpdate(
  { name: 'Inventory & POS' },
  {
    name: 'Inventory & POS',
    type: 'software',
    description: 'Multi-warehouse stock movements, barcodes, purchase orders, and POS terminals.',
    salesPriceMinor: 200000, // ₹2,000.00
    costPriceMinor: 45000, // ₹450.00
    notes: 'Real-time stock reservation and valuation.',
    status: 'active',
  },
  { upsert: true, new: true },
);

const productBackup = await Product.findOneAndUpdate(
  { name: 'Cloud Vault Backup' },
  {
    name: 'Cloud Vault Backup',
    type: 'service',
    description: 'Daily automated encrypted database snapshots and disaster recovery.',
    salesPriceMinor: 50000, // ₹500.00
    costPriceMinor: 10000, // ₹100.00
    notes: 'Zero-knowledge client-side encryption.',
    status: 'active',
  },
  { upsert: true, new: true },
);

// Variants for Accounting Software (Prompt/PDF requirement: Odoo brand adds 560)
const variantStd = await ProductVariant.findOneAndUpdate(
  { productId: productAccounting._id, name: 'Standard Edition' },
  {
    productId: productAccounting._id,
    name: 'Standard Edition',
    additionalPriceMinor: 0,
    status: 'active',
  },
  { upsert: true, new: true },
);

const variantOdoo = await ProductVariant.findOneAndUpdate(
  { productId: productAccounting._id, name: 'Odoo Edition' },
  {
    productId: productAccounting._id,
    name: 'Odoo Edition',
    additionalPriceMinor: 56000,
    status: 'active',
  },
  { upsert: true, new: true },
);

const variantPremium = await ProductVariant.findOneAndUpdate(
  { productId: productAccounting._id, name: 'Premium Multi-Entity' },
  {
    productId: productAccounting._id,
    name: 'Premium Multi-Entity',
    additionalPriceMinor: 100000,
    status: 'active',
  },
  { upsert: true, new: true },
);
console.log(
  '✓ Products & Variants populated (Accounting, Odoo +₹560 delta, CRM, Inventory, Backup)',
);

// 6. Taxes
const taxGST = await Tax.findOneAndUpdate(
  { name: 'GST 18%' },
  {
    name: 'GST 18%',
    rateBps: 1800, // 18.00%
    type: 'exclusive',
    productIds: [productAccounting._id, productCRM._id, productInventory._id, productBackup._id],
    effectiveFrom: new Date('2026-01-01'),
    active: true,
  },
  { upsert: true, new: true },
);
console.log('✓ Taxes configured: GST 18%');

// 7. Discounts
const discountLaunch = await Discount.findOneAndUpdate(
  { name: 'Launch 10% Off' },
  {
    name: 'Launch 10% Off',
    kind: 'percentage',
    value: 1000, // 10.00%
    minPurchaseMinor: 100000, // Min ₹1,000
    minQuantity: 1,
    startAt: new Date('2026-01-01'),
    endAt: new Date('2027-12-31'),
    maxRedemptions: 100,
    usedCount: 1,
    scope: 'subscription',
    active: true,
  },
  { upsert: true, new: true },
);
console.log('✓ Discounts configured: Launch 10% Off');

// 8. Subscription Plans
const planMonthlyPro = await Plan.findOneAndUpdate(
  { name: 'Monthly Professional' },
  {
    name: 'Monthly Professional',
    description: 'Accounting Software + CRM Suite billed monthly. Perfect for growing SMEs.',
    products: [
      { productId: productAccounting._id, unitPriceMinor: 100000 },
      { productId: productCRM._id, unitPriceMinor: 150000 },
    ],
    frequency: 'monthly',
    minQuantity: 1,
    availableFrom: new Date('2026-01-01'),
    autoClose: false,
    allowPause: true,
    allowEarlyClosure: true,
    allowRenewal: true,
    status: 'active',
  },
  { upsert: true, new: true },
);

const planYearlyEnterprise = await Plan.findOneAndUpdate(
  { name: 'Yearly Enterprise Suite' },
  {
    name: 'Yearly Enterprise Suite',
    description:
      'Full software stack including Accounting, CRM, Inventory & Cloud Backup billed annually.',
    products: [
      { productId: productAccounting._id, unitPriceMinor: 1000000 }, // ₹10,000/yr
      { productId: productCRM._id, unitPriceMinor: 1500000 }, // ₹15,000/yr
      { productId: productInventory._id, unitPriceMinor: 2000000 }, // ₹20,000/yr
    ],
    frequency: 'yearly',
    minQuantity: 1,
    availableFrom: new Date('2026-01-01'),
    autoClose: false,
    allowPause: true,
    allowEarlyClosure: false,
    allowRenewal: true,
    status: 'active',
  },
  { upsert: true, new: true },
);

const planWeeklyStarter = await Plan.findOneAndUpdate(
  { name: 'Weekly Starter' },
  {
    name: 'Weekly Starter',
    description: 'Standalone Accounting Software billed weekly for fast-paced short-term projects.',
    products: [{ productId: productAccounting._id, unitPriceMinor: 30000 }],
    frequency: 'weekly',
    minQuantity: 1,
    availableFrom: new Date('2026-01-01'),
    autoClose: false,
    allowPause: false,
    allowEarlyClosure: true,
    allowRenewal: true,
    status: 'active',
  },
  { upsert: true, new: true },
);
console.log('✓ Subscription Plans created (Monthly Pro, Yearly Enterprise, Weekly Starter)');

// 9. Quotation Template
const quoteTemplate = await QuotationTemplate.findOneAndUpdate(
  { name: 'Standard SME Proposal Template' },
  {
    name: 'Standard SME Proposal Template',
    planId: planMonthlyPro._id,
    quantity: 1,
    terms: 'Net 30 days. Priority SLA email & chat support included.',
    active: true,
  },
  { upsert: true, new: true },
);
console.log('✓ Quotation Template created');

// 10. Active Subscriptions
const sub1StartDate = new Date(Date.now() - 30 * 86400_000); // 1 month ago
const sub1NextBilling = new Date(Date.now() + 30 * 86400_000); // 1 month in future

const subAbhishek = await Subscription.findOneAndUpdate(
  { number: 'SUB-2026-000001' },
  {
    number: 'SUB-2026-000001',
    customerId: customerAbhishek._id,
    planId: planMonthlyPro._id,
    planSnapshot: {
      name: planMonthlyPro.name,
      allowPause: true,
      allowEarlyClosure: true,
      allowRenewal: true,
      autoClose: false,
    },
    startAt: sub1StartDate,
    frequency: 'monthly',
    anchorDay: sub1StartDate.getUTCDate(),
    anchorMonth: sub1StartDate.getUTCMonth() + 1,
    nextBillingAt: sub1NextBilling,
    paymentTermsDays: 7,
    status: 'active',
    lines: [
      {
        productId: productAccounting._id,
        variantId: variantOdoo._id,
        name: 'Accounting Software — Odoo Edition',
        quantity: 1,
        unitPriceMinor: 156000, // ₹1,000 + ₹560 = ₹1,560
        baseMinor: 156000,
        discountMinor: 15600, // 10%
        taxMinor: 25272, // 18% on (156000 - 15600) = 140400 * 0.18 = 25272
        totalMinor: 165672,
        taxes: [{ taxId: taxGST._id, name: 'GST 18%', rateBps: 1800, amountMinor: 25272 }],
        discounts: [{ discountId: discountLaunch._id, name: 'Launch 10% Off', amountMinor: 15600 }],
      },
      {
        productId: productCRM._id,
        name: 'CRM & Lead Suite',
        quantity: 1,
        unitPriceMinor: 150000, // ₹1,500
        baseMinor: 150000,
        discountMinor: 15000, // 10%
        taxMinor: 24300, // 18% on 135000 = 24300
        totalMinor: 159300,
        taxes: [{ taxId: taxGST._id, name: 'GST 18%', rateBps: 1800, amountMinor: 24300 }],
        discounts: [{ discountId: discountLaunch._id, name: 'Launch 10% Off', amountMinor: 15000 }],
      },
    ],
    subtotalMinor: 306000,
    discountMinor: 30600,
    taxMinor: 49572,
    totalMinor: 324972,
  },
  { upsert: true, new: true },
);

const subAcme = await Subscription.findOneAndUpdate(
  { number: 'SUB-2026-000002' },
  {
    number: 'SUB-2026-000002',
    customerId: customerAcme._id,
    planId: planYearlyEnterprise._id,
    planSnapshot: {
      name: planYearlyEnterprise.name,
      allowPause: true,
      allowEarlyClosure: false,
      allowRenewal: true,
      autoClose: false,
    },
    startAt: new Date(Date.now() - 15 * 86400_000),
    frequency: 'yearly',
    anchorDay: 15,
    anchorMonth: 10,
    nextBillingAt: new Date(Date.now() + 350 * 86400_000),
    paymentTermsDays: 15,
    status: 'active',
    lines: [
      {
        productId: productAccounting._id,
        name: 'Accounting Software — Standard Edition',
        quantity: 1,
        unitPriceMinor: 1000000,
        baseMinor: 1000000,
        discountMinor: 0,
        taxMinor: 180000,
        totalMinor: 1180000,
        taxes: [{ taxId: taxGST._id, name: 'GST 18%', rateBps: 1800, amountMinor: 180000 }],
      },
    ],
    subtotalMinor: 1000000,
    discountMinor: 0,
    taxMinor: 180000,
    totalMinor: 1180000,
  },
  { upsert: true, new: true },
);
console.log('✓ Active Subscriptions created for Abhishek & Acme Corp');

// 11. Invoices
// Invoice 1: Paid invoice for Abhishek
const inv1IssuedAt = new Date(Date.now() - 30 * 86400_000);
const invoicePaid = await Invoice.findOneAndUpdate(
  { number: 'INV-2026-00001' },
  {
    number: 'INV-2026-00001',
    customerId: customerAbhishek._id,
    subscriptionId: subAbhishek._id,
    planId: planMonthlyPro._id,
    planName: planMonthlyPro.name,
    customerSnapshot: {
      name: customerAbhishek.name,
      email: customerAbhishek.email,
      company: customerAbhishek.company,
      address: customerAbhishek.address,
      taxId: customerAbhishek.taxId,
    },
    companySnapshot: {
      name: 'Brightloop Software',
      footer: 'Thank you for choosing Brightloop Software! Subscriptions billed automatically.',
    },
    issuedAt: inv1IssuedAt,
    dueAt: new Date(inv1IssuedAt.getTime() + 7 * 86400_000),
    currency: 'INR',
    lines: subAbhishek.lines,
    subtotalMinor: 306000,
    discountMinor: 30600,
    taxMinor: 49572,
    totalMinor: 324972,
    paidMinor: 324972, // Fully paid!
    status: 'confirmed',
  },
  { upsert: true, new: true },
);

// Payment for Invoice 1
const payment1 = await Payment.findOneAndUpdate(
  { idempotencyKey: 'pay-seed-001' },
  {
    customerId: customerAbhishek._id,
    amountMinor: 324972,
    allocatedMinor: 324972,
    currency: 'INR',
    method: 'UPI / NetBanking',
    reference: 'RZP-PAY-SEED-882194',
    provider: 'razorpay',
    providerPaymentId: 'pay_NalR6seed001',
    idempotencyKey: 'pay-seed-001',
    status: 'captured',
    paidAt: new Date(inv1IssuedAt.getTime() + 1 * 86400_000),
    notes: 'Online payment captured successfully via Razorpay UPI.',
  },
  { upsert: true, new: true },
);

await PaymentAllocation.findOneAndUpdate(
  { paymentId: payment1._id, invoiceId: invoicePaid._id },
  {
    paymentId: payment1._id,
    invoiceId: invoicePaid._id,
    amountMinor: 324972,
  },
  { upsert: true },
);

// Invoice 2: Outstanding Confirmed Invoice for Abhishek (for customer portal payment testing)
const inv2IssuedAt = new Date();
const invoiceDue = await Invoice.findOneAndUpdate(
  { number: 'INV-2026-00002' },
  {
    number: 'INV-2026-00002',
    customerId: customerAbhishek._id,
    subscriptionId: subAbhishek._id,
    planId: planMonthlyPro._id,
    planName: planMonthlyPro.name,
    customerSnapshot: {
      name: customerAbhishek.name,
      email: customerAbhishek.email,
      company: customerAbhishek.company,
      address: customerAbhishek.address,
      taxId: customerAbhishek.taxId,
    },
    companySnapshot: {
      name: 'Brightloop Software',
      footer: 'Thank you for choosing Brightloop Software! Subscriptions billed automatically.',
    },
    issuedAt: inv2IssuedAt,
    dueAt: new Date(inv2IssuedAt.getTime() + 7 * 86400_000),
    currency: 'INR',
    lines: subAbhishek.lines,
    subtotalMinor: 306000,
    discountMinor: 30600,
    taxMinor: 49572,
    totalMinor: 324972,
    paidMinor: 0, // Unpaid balance of ₹3,249.72 ready to pay!
    status: 'confirmed',
  },
  { upsert: true, new: true },
);

// Invoice 3: Paid Invoice for Acme Corp
const invoiceAcme = await Invoice.findOneAndUpdate(
  { number: 'INV-2026-00003' },
  {
    number: 'INV-2026-00003',
    customerId: customerAcme._id,
    subscriptionId: subAcme._id,
    planId: planYearlyEnterprise._id,
    planName: planYearlyEnterprise.name,
    customerSnapshot: {
      name: customerAcme.name,
      email: customerAcme.email,
      company: customerAcme.company,
      address: customerAcme.address,
      taxId: customerAcme.taxId,
    },
    companySnapshot: {
      name: 'Brightloop Software',
      footer: 'Thank you for choosing Brightloop Software! Subscriptions billed automatically.',
    },
    issuedAt: new Date(Date.now() - 15 * 86400_000),
    dueAt: new Date(Date.now() - 1 * 86400_000),
    currency: 'INR',
    lines: subAcme.lines,
    subtotalMinor: 1000000,
    discountMinor: 0,
    taxMinor: 180000,
    totalMinor: 1180000,
    paidMinor: 1180000,
    status: 'confirmed',
  },
  { upsert: true, new: true },
);

const paymentAcme = await Payment.findOneAndUpdate(
  { idempotencyKey: 'pay-seed-002' },
  {
    customerId: customerAcme._id,
    amountMinor: 1180000,
    allocatedMinor: 1180000,
    currency: 'INR',
    method: 'Corporate Bank Transfer / RTGS',
    reference: 'HDFC-RTGS-ACME-99120',
    provider: 'manual',
    idempotencyKey: 'pay-seed-002',
    status: 'captured',
    paidAt: new Date(Date.now() - 10 * 86400_000),
    notes: 'Received via HDFC Bank RTGS, reconciled by Priya Sharma.',
  },
  { upsert: true, new: true },
);

await PaymentAllocation.findOneAndUpdate(
  { paymentId: paymentAcme._id, invoiceId: invoiceAcme._id },
  {
    paymentId: paymentAcme._id,
    invoiceId: invoiceAcme._id,
    amountMinor: 1180000,
  },
  { upsert: true },
);
console.log(
  '✓ Invoices & Payments created: 1 paid invoice, 1 outstanding invoice for Abhishek, 1 paid invoice for Acme',
);

// 12. Quotations
await Quotation.findOneAndUpdate(
  { number: 'QT-2026-00001' },
  {
    number: 'QT-2026-00001',
    customerId: customerAbhishek._id,
    planId: planMonthlyPro._id,
    templateId: quoteTemplate._id,
    expiryAt: new Date(Date.now() + 15 * 86400_000),
    lines: subAbhishek.lines,
    subtotalMinor: 306000,
    discountMinor: 30600,
    taxMinor: 49572,
    totalMinor: 324972,
    terms: 'Standard Brightloop 30-day payment terms.',
    status: 'accepted',
    convertedSubscriptionId: subAbhishek._id,
  },
  { upsert: true, new: true },
);

await Quotation.findOneAndUpdate(
  { number: 'QT-2026-00002' },
  {
    number: 'QT-2026-00002',
    customerId: customerAcme._id,
    planId: planMonthlyPro._id,
    templateId: quoteTemplate._id,
    expiryAt: new Date(Date.now() + 25 * 86400_000),
    lines: subAbhishek.lines,
    subtotalMinor: 306000,
    discountMinor: 0,
    taxMinor: 55080,
    totalMinor: 361080,
    terms: 'Annual renewal discount applicable upon confirmation.',
    status: 'sent',
  },
  { upsert: true, new: true },
);
console.log('✓ Quotations created (1 accepted & converted, 1 sent open quote)');

// 13. Audit Log
await AuditLog.create([
  {
    actorId: adminUser._id,
    role: 'admin',
    action: 'initialized_catalog',
    resourceType: 'Product',
    resourceId: String(productAccounting._id),
    after: { name: 'Accounting Software', variants: 3 },
  },
  {
    actorId: staffUser._id,
    role: 'staff',
    action: 'converted_quotation',
    resourceType: 'Quotation',
    resourceId: 'QT-2026-00001',
    after: { subscriptionId: String(subAbhishek._id) },
  },
]);
console.log('✓ Audit logs recorded');

console.log('\n======================================================');
console.log('SEEDING COMPLETE! Full Brightloop dataset populated:');
console.log('1. Admin: admin@brightloop.io / BrightloopAdmin!2026');
console.log('2. Staff: staff@brightloop.io / BrightloopStaff!2026');
console.log('3. Customer: abhisheknanaware39@gmail.com (Verified)');
console.log('======================================================\n');

await mongoose.disconnect();

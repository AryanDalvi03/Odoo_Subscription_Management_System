import { Schema, model } from 'mongoose';
const ref = (name: string, required = true) => ({
  type: Schema.Types.ObjectId,
  ref: name,
  required,
});
const opts = { timestamps: true, optimisticConcurrency: true } as const;
const money = { type: Number, required: true, min: 0, validate: Number.isSafeInteger };
const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['admin', 'staff', 'customer'], required: true },
    verifiedAt: Date,
    active: { type: Boolean, default: true },
    permissions: [String],
  },
  opts,
);
export const User = model('User', userSchema);
export const Customer = model(
  'Customer',
  new Schema(
    {
      userId: { ...ref('User', false), unique: true, sparse: true },
      name: { type: String, required: true },
      email: { type: String, required: true },
      company: String,
      phone: String,
      address: String,
      taxId: String,
      assignedStaffIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      status: { type: String, default: 'active' },
    },
    opts,
  ),
);
Customer.schema.index({ assignedStaffIds: 1, status: 1 });
export const Session = model(
  'Session',
  new Schema(
    {
      userId: ref('User'),
      tokenHash: { type: String, unique: true, required: true },
      family: { type: String, required: true },
      expiresAt: { type: Date, required: true },
      revokedAt: Date,
    },
    opts,
  ),
);
Session.schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const AuthToken = model(
  'AuthToken',
  new Schema(
    {
      userId: ref('User'),
      tokenHash: { type: String, unique: true, required: true },
      purpose: { type: String, enum: ['verify', 'reset'], required: true },
      expiresAt: { type: Date, required: true },
      usedAt: Date,
    },
    opts,
  ),
);
AuthToken.schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const Product = model(
  'Product',
  new Schema(
    {
      name: { type: String, required: true },
      type: { type: String, default: 'software' },
      description: String,
      salesPriceMinor: money,
      costPriceMinor: money,
      notes: String,
      status: { type: String, enum: ['active', 'archived'], default: 'active' },
    },
    opts,
  ),
);
Product.schema.index({ status: 1, name: 1 });
export const ProductVariant = model(
  'ProductVariant',
  new Schema(
    {
      productId: ref('Product'),
      name: { type: String, required: true },
      additionalPriceMinor: money,
      status: { type: String, default: 'active' },
    },
    opts,
  ),
);
ProductVariant.schema.index({ productId: 1, name: 1 }, { unique: true });
const planProduct = new Schema(
  { productId: ref('Product'), unitPriceMinor: money },
  { _id: false },
);
export const Plan = model(
  'Plan',
  new Schema(
    {
      name: { type: String, required: true },
      description: String,
      products: { type: [planProduct], required: true },
      frequency: { type: String, enum: ['daily', 'weekly', 'monthly', 'yearly'], required: true },
      minQuantity: { type: Number, default: 1 },
      availableFrom: Date,
      availableUntil: Date,
      autoClose: { type: Boolean, default: false },
      allowPause: { type: Boolean, default: false },
      allowEarlyClosure: { type: Boolean, default: false },
      allowRenewal: { type: Boolean, default: true },
      status: { type: String, enum: ['active', 'inactive', 'archived'], default: 'active' },
    },
    opts,
  ),
);
export const Tax = model(
  'Tax',
  new Schema(
    {
      name: { type: String, required: true },
      rateBps: { type: Number, required: true },
      type: { type: String, enum: ['exclusive'], default: 'exclusive' },
      productIds: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
      effectiveFrom: { type: Date, required: true },
      effectiveUntil: Date,
      active: { type: Boolean, default: true },
    },
    opts,
  ),
);
export const Discount = model(
  'Discount',
  new Schema(
    {
      name: { type: String, required: true },
      kind: { type: String, enum: ['fixed', 'percentage'], required: true },
      value: money,
      minPurchaseMinor: { type: Number, default: 0 },
      minQuantity: { type: Number, default: 1 },
      startAt: { type: Date, required: true },
      endAt: { type: Date, required: true },
      maxRedemptions: Number,
      usedCount: { type: Number, default: 0 },
      scope: { type: String, enum: ['product', 'subscription'], default: 'subscription' },
      productIds: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
      active: { type: Boolean, default: true },
    },
    opts,
  ),
);
const line = new Schema(
  {
    productId: ref('Product'),
    variantId: ref('ProductVariant', false),
    name: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitPriceMinor: money,
    baseMinor: money,
    discountMinor: money,
    taxMinor: money,
    totalMinor: money,
    discounts: [{ discountId: ref('Discount'), name: String, amountMinor: money }],
    taxes: [{ taxId: ref('Tax'), name: String, rateBps: Number, amountMinor: money }],
  },
  { _id: false },
);
export const QuotationTemplate = model(
  'QuotationTemplate',
  new Schema(
    {
      name: { type: String, required: true },
      planId: ref('Plan'),
      quantity: { type: Number, default: 1 },
      terms: String,
      active: { type: Boolean, default: true },
    },
    opts,
  ),
);
const totals = { subtotalMinor: money, discountMinor: money, taxMinor: money, totalMinor: money };
export const Quotation = model(
  'Quotation',
  new Schema(
    {
      number: { type: String, unique: true, required: true },
      customerId: ref('Customer'),
      planId: ref('Plan'),
      templateId: ref('QuotationTemplate', false),
      expiryAt: { type: Date, required: true },
      lines: [line],
      ...totals,
      terms: String,
      status: {
        type: String,
        enum: ['draft', 'sent', 'accepted', 'rejected', 'expired'],
        default: 'draft',
      },
      convertedSubscriptionId: ref('Subscription', false),
    },
    opts,
  ),
);
Quotation.schema.index({ customerId: 1, status: 1, expiryAt: 1 });
export const Subscription = model(
  'Subscription',
  new Schema(
    {
      number: { type: String, required: true, unique: true },
      customerId: ref('Customer'),
      planId: ref('Plan'),
      sourceQuotationId: { ...ref('Quotation', false), unique: true, sparse: true },
      predecessorId: ref('Subscription', false),
      planSnapshot: {
        name: String,
        allowPause: Boolean,
        allowEarlyClosure: Boolean,
        allowRenewal: Boolean,
        autoClose: Boolean,
      },
      startAt: { type: Date, required: true },
      expiryAt: Date,
      frequency: { type: String, required: true },
      billingTimezone: { type: String, default: 'Asia/Kolkata' },
      anchorDay: { type: Number, required: true },
      anchorMonth: { type: Number, required: true },
      nextBillingAt: { type: Date, required: true },
      paymentTermsDays: { type: Number, default: 7 },
      lines: [line],
      ...totals,
      status: {
        type: String,
        enum: ['draft', 'quotation', 'confirmed', 'active', 'paused', 'cancelled', 'closed'],
        default: 'draft',
      },
      pauseAt: Date,
      cancelAt: Date,
      pendingPlanId: ref('Plan', false),
    },
    opts,
  ),
);
Subscription.schema.index({ status: 1, nextBillingAt: 1 });
Subscription.schema.index({ customerId: 1, status: 1 });
Subscription.schema.index({ predecessorId: 1 }, { unique: true, sparse: true });
export const Invoice = model(
  'Invoice',
  new Schema(
    {
      number: { type: String, unique: true, required: true },
      customerId: ref('Customer'),
      subscriptionId: ref('Subscription'),
      planId: ref('Plan', false),
      planName: String,
      cancelledAt: Date,
      creditedPreTaxMinor: { type: Number, default: 0 },
      creditedTaxMinor: { type: Number, default: 0 },
      billingRecordId: { ...ref('BillingRecord', false), unique: true, sparse: true },
      cycleKey: { type: String, unique: true, sparse: true },
      cycleStart: Date,
      companySnapshot: { name: String, footer: String },
      customerSnapshot: {
        name: String,
        email: String,
        company: String,
        address: String,
        taxId: String,
      },
      issuedAt: { type: Date, required: true },
      dueAt: { type: Date, required: true },
      currency: { type: String, default: 'INR' },
      lines: [line],
      ...totals,
      paidMinor: { type: Number, default: 0 },
      creditedMinor: { type: Number, default: 0 },
      status: { type: String, enum: ['draft', 'confirmed', 'cancelled'], default: 'confirmed' },
    },
    opts,
  ),
);
Invoice.schema.index({ customerId: 1, dueAt: 1 });
Invoice.schema.index({ status: 1, dueAt: 1 });
export const Payment = model(
  'Payment',
  new Schema(
    {
      customerId: ref('Customer'),
      amountMinor: money,
      allocatedMinor: { type: Number, default: 0 },
      currency: { type: String, default: 'INR' },
      method: String,
      reference: String,
      provider: { type: String, enum: ['manual', 'razorpay'], required: true },
      providerPaymentId: { type: String, unique: true, sparse: true },
      idempotencyKey: { type: String, unique: true, required: true },
      status: { type: String, enum: ['captured', 'failed'], required: true },
      paidAt: { type: Date, required: true },
      notes: String,
    },
    opts,
  ),
);
export const PaymentAllocation = model(
  'PaymentAllocation',
  new Schema({ paymentId: ref('Payment'), invoiceId: ref('Invoice'), amountMinor: money }, opts),
);
PaymentAllocation.schema.index({ paymentId: 1, invoiceId: 1 }, { unique: true });
export const BillingRecord = model(
  'BillingRecord',
  new Schema(
    {
      subscriptionId: ref('Subscription'),
      cycleStart: { type: Date, required: true },
      cycleEnd: { type: Date, required: true },
      cycleKey: { type: String, required: true, unique: true },
      invoiceId: ref('Invoice', false),
      status: { type: String, default: 'completed' },
    },
    opts,
  ),
);
BillingRecord.schema.index({ subscriptionId: 1, cycleStart: 1 }, { unique: true });
export const DiscountUsage = model(
  'DiscountUsage',
  new Schema(
    {
      discountId: ref('Discount'),
      invoiceId: ref('Invoice'),
      subscriptionId: ref('Subscription'),
      amountMinor: money,
      redemptionKey: { type: String, required: true, unique: true },
    },
    opts,
  ),
);
export const Notification = model(
  'Notification',
  new Schema(
    {
      recipient: { type: String, required: true },
      subject: { type: String, required: true },
      text: { type: String, required: true },
      eventKey: { type: String, unique: true, required: true },
      status: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending' },
      attempts: { type: Number, default: 0 },
      providerMessageId: String,
      sentAt: Date,
      lastError: String,
    },
    opts,
  ),
);
export const AuditLog = model(
  'AuditLog',
  new Schema(
    {
      actorId: ref('User', false),
      role: String,
      action: { type: String, required: true },
      resourceType: String,
      resourceId: String,
      before: Schema.Types.Mixed,
      after: Schema.Types.Mixed,
      ip: String,
    },
    { timestamps: true },
  ),
);
AuditLog.schema.index({ resourceType: 1, resourceId: 1, createdAt: -1 });
export const SubscriptionEvent = model(
  'SubscriptionEvent',
  new Schema(
    {
      subscriptionId: ref('Subscription'),
      actorId: ref('User', false),
      action: String,
      from: String,
      to: String,
      reason: String,
      recurringMinor: Number,
      frequency: String,
      effectiveAt: { type: Date, required: true },
    },
    { timestamps: true },
  ),
);
export const ChangeRequest = model(
  'ChangeRequest',
  new Schema(
    {
      subscriptionId: ref('Subscription'),
      customerId: ref('Customer'),
      kind: { type: String, enum: ['cancel', 'upgrade', 'downgrade'], required: true },
      planId: ref('Plan', false),
      reason: String,
      status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
      reviewedBy: ref('User', false),
    },
    opts,
  ),
);
export const PaymentOrder = model(
  'PaymentOrder',
  new Schema(
    {
      customerId: ref('Customer'),
      invoiceId: ref('Invoice'),
      amountMinor: money,
      providerOrderId: { type: String, unique: true, sparse: true },
      requestKey: { type: String, unique: true, required: true },
      status: { type: String, default: 'created' },
    },
    opts,
  ),
);
export const WebhookEvent = model(
  'WebhookEvent',
  new Schema(
    {
      eventId: { type: String, unique: true, required: true },
      payloadHash: String,
      status: { type: String, default: 'pending' },
      payload: Schema.Types.Mixed,
    },
    opts,
  ),
);
export const CreditNote = model(
  'CreditNote',
  new Schema(
    {
      number: { type: String, required: true, unique: true },
      invoiceId: ref('Invoice'),
      amountMinor: money,
      preTaxMinor: money,
      taxMinor: money,
      reason: { type: String, required: true },
      actorId: ref('User'),
      requestKey: { type: String, required: true, unique: true },
    },
    opts,
  ),
);
export const SystemSetting = model(
  'SystemSetting',
  new Schema(
    { key: { type: String, unique: true, required: true }, value: Schema.Types.Mixed },
    opts,
  ),
);
export const Sequence = model(
  'Sequence',
  new Schema({
    key: { type: String, unique: true, required: true },
    value: { type: Number, default: 0 },
  }),
);
export const Command = model(
  'Command',
  new Schema(
    {
      key: { type: String, unique: true, required: true },
      hash: { type: String, required: true },
      resultId: { type: String, required: true },
      type: { type: String, required: true },
    },
    opts,
  ),
);
Session.schema.index({ userId: 1, family: 1 });
AuthToken.schema.index({ userId: 1, purpose: 1, expiresAt: 1 });
Plan.schema.index({ status: 1, availableFrom: 1, availableUntil: 1 });
Tax.schema.index({ active: 1, effectiveFrom: 1 });
Discount.schema.index({ active: 1, startAt: 1, endAt: 1 });
DiscountUsage.schema.index({ discountId: 1, invoiceId: 1 });
Invoice.schema.index({ status: 1, issuedAt: 1 });
Payment.schema.index({ customerId: 1, paidAt: -1 });
Payment.schema.index({ status: 1, paidAt: 1 });
Notification.schema.index({ status: 1, attempts: 1, createdAt: 1 });
AuditLog.schema.index({ actorId: 1, createdAt: -1 });
SubscriptionEvent.schema.index({ subscriptionId: 1, effectiveAt: 1 });
ChangeRequest.schema.index({ customerId: 1, status: 1 });
PaymentOrder.schema.index({ status: 1, updatedAt: 1 });
WebhookEvent.schema.index({ status: 1, createdAt: 1 });

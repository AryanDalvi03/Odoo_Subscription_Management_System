import { z } from 'zod';
export const id = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid resource identifier');
export const minor = z.number().int().min(0).max(1_000_000_000);
export const quantity = z.number().int().min(1).max(100_000);
export const date = z.iso.datetime().transform((value) => new Date(value));
const text = z.string().trim().max(4000);
export const productInput = z
  .object({
    name: text.min(2).max(150),
    type: text.min(1).default('software'),
    description: text.default(''),
    salesPriceMinor: minor,
    costPriceMinor: minor,
    notes: text.default(''),
    status: z.enum(['active', 'archived']).default('active'),
  })
  .strict();
export const variantInput = z
  .object({
    name: text.min(1).max(100),
    additionalPriceMinor: minor,
    status: z.enum(['active', 'archived']).default('active'),
  })
  .strict();
export const planInput = z
  .object({
    name: text.min(2).max(150),
    description: text.default(''),
    products: z
      .array(z.object({ productId: id, unitPriceMinor: minor }).strict())
      .min(1)
      .max(50),
    frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    minQuantity: quantity.default(1),
    availableFrom: date.optional(),
    availableUntil: date.optional(),
    autoClose: z.boolean().default(false),
    allowPause: z.boolean().default(false),
    allowEarlyClosure: z.boolean().default(false),
    allowRenewal: z.boolean().default(true),
    status: z.enum(['active', 'inactive', 'archived']).default('active'),
  })
  .strict()
  .refine((v) => !v.availableUntil || !v.availableFrom || v.availableUntil > v.availableFrom, {
    message: 'Availability end must follow start',
    path: ['availableUntil'],
  })
  .refine((v) => new Set(v.products.map((p) => p.productId)).size === v.products.length, {
    message: 'Products must be unique',
    path: ['products'],
  });
export const taxInput = z
  .object({
    name: text.min(2),
    rateBps: z.number().int().min(0).max(10000),
    type: z.literal('exclusive').default('exclusive'),
    productIds: z.array(id).max(100).default([]),
    effectiveFrom: date,
    effectiveUntil: date.optional(),
    active: z.boolean().default(true),
  })
  .strict()
  .refine((v) => !v.effectiveUntil || v.effectiveUntil > v.effectiveFrom, {
    path: ['effectiveUntil'],
    message: 'End must follow start',
  });
export const discountInput = z
  .object({
    name: text.min(2),
    kind: z.enum(['fixed', 'percentage']),
    value: minor,
    minPurchaseMinor: minor.default(0),
    minQuantity: quantity.default(1),
    startAt: date,
    endAt: date,
    maxRedemptions: quantity.optional(),
    scope: z.enum(['product', 'subscription']).default('subscription'),
    productIds: z.array(id).default([]),
    active: z.boolean().default(true),
  })
  .strict()
  .refine((v) => v.endAt > v.startAt, { path: ['endAt'], message: 'End must follow start' })
  .refine((v) => v.kind !== 'percentage' || v.value <= 10000, {
    path: ['value'],
    message: 'Percentage cannot exceed 10000 basis points',
  })
  .refine((v) => v.scope !== 'product' || v.productIds.length > 0, {
    path: ['productIds'],
    message: 'Choose applicable products',
  });
export const customerInput = z
  .object({
    name: text.min(2).max(150),
    email: z.email().transform((v) => v.trim().toLowerCase()),
    company: text.default(''),
    phone: text.max(40).default(''),
    address: text.default(''),
    taxId: text.max(100).default(''),
    assignedStaffIds: z.array(id).default([]),
  })
  .strict();
export const templateInput = z
  .object({
    name: text.min(2),
    planId: id,
    quantity: quantity.default(1),
    terms: text.default(''),
    active: z.boolean().default(true),
  })
  .strict();

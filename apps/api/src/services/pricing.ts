import type { ClientSession } from 'mongoose';
import { calculate, type PriceLine } from '@subscriptiq/domain';
import { Plan, Product, ProductVariant, Tax, Discount } from '../models/index.js';
import { ensure } from '../lib/errors.js';
export async function pricePlan(
  planId: string,
  quantity: number,
  variants: Record<string, string> = {},
  session?: ClientSession,
  at = new Date(),
) {
  const plan = await Plan.findOne({
    _id: planId,
    status: 'active',
    $and: [
      { $or: [{ availableFrom: { $exists: false } }, { availableFrom: { $lte: at } }] },
      { $or: [{ availableUntil: { $exists: false } }, { availableUntil: { $gt: at } }] },
    ],
  }).session(session ?? null);
  ensure(plan, 422, 'PLAN_UNAVAILABLE', 'This plan is unavailable');
  ensure(
    quantity >= plan.minQuantity,
    422,
    'MIN_QUANTITY',
    `Minimum quantity is ${plan.minQuantity}`,
  );
  const products = await Product.find({
    _id: { $in: plan.products.map((p) => p.productId) },
    status: 'active',
  }).session(session ?? null);
  ensure(
    products.length === plan.products.length,
    422,
    'PRODUCT_UNAVAILABLE',
    'A linked product is archived or missing',
  );
  ensure(
    Object.keys(variants).every((key) => plan.products.some((p) => String(p.productId) === key)),
    422,
    'INVALID_VARIANT',
    'A variant selection references a product outside this plan',
  );
  const lines: PriceLine[] = [];
  for (const configured of plan.products) {
    const product = products.find((p) => String(p._id) === String(configured.productId))!;
    const variantId = variants[String(product._id)];
    const variant = variantId
      ? await ProductVariant.findOne({
          _id: variantId,
          productId: product._id,
          status: 'active',
        }).session(session ?? null)
      : undefined;
    ensure(
      !variantId || variant,
      422,
      'INVALID_VARIANT',
      'Variant does not belong to this product',
    );
    const price = configured.unitPriceMinor + (variant?.additionalPriceMinor ?? 0);
    ensure(Number.isSafeInteger(price), 422, 'PRICE_OVERFLOW', 'Price exceeds supported limits');
    lines.push({
      productId: String(product._id),
      variantId: variant ? String(variant._id) : undefined,
      name: product.name + (variant ? ` — ${variant.name}` : ''),
      quantity,
      unitPriceMinor: price,
    });
  }
  return { plan, ...(await priceLines(lines, at, session)) };
}
export async function priceLines(lines: PriceLine[], at: Date, session?: ClientSession) {
  const taxes = await Tax.find({
    active: true,
    effectiveFrom: { $lte: at },
    $or: [{ effectiveUntil: { $exists: false } }, { effectiveUntil: { $gt: at } }],
  }).session(session ?? null);
  const discounts = await Discount.find({
    active: true,
    startAt: { $lte: at },
    endAt: { $gt: at },
    $or: [
      { maxRedemptions: { $exists: false } },
      { $expr: { $lt: ['$usedCount', '$maxRedemptions'] } },
    ],
  })
    .session(session ?? null)
    .sort({ _id: 1 });
  return calculate(
    lines,
    taxes.map((t) => ({
      id: String(t._id),
      name: t.name,
      rateBps: t.rateBps,
      productIds: t.productIds.map(String),
    })),
    discounts.map((d) => ({
      id: String(d._id),
      name: d.name,
      kind: d.kind,
      value: d.value,
      minPurchaseMinor: d.minPurchaseMinor,
      minQuantity: d.minQuantity,
      productIds: d.scope === 'subscription' ? [] : d.productIds.map(String),
    })),
  );
}

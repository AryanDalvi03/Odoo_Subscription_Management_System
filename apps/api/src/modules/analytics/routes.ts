import { Router } from 'express';
import type { Redis } from 'ioredis';
import { cachedAnalytics } from '../../services/cache.js';
import { z } from 'zod';
import {
  allocateMinor,
  recurringRevenue,
  reportPeriodStart,
  reportMonths,
} from '@subscriptiq/domain';
import {
  Customer,
  Subscription,
  Invoice,
  Payment,
  AuditLog,
  SubscriptionEvent,
  PaymentAllocation,
  CreditNote,
} from '../../models/index.js';
import { authenticate, type AuthConfig } from '../auth/service.js';
import { ensure } from '../../lib/errors.js';
import { actorOf } from '../catalog/routes.js';
import { customerScope, resourceScope, permit } from '../../services/context.js';
export const rangeInput = z
  .object({
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    range: z.enum(['today', '7', '30', '90', 'year', 'custom']).default('30'),
  })
  .strict();
export function reportRange(input: z.infer<typeof rangeInput>) {
  const to = input.to ? new Date(input.to) : new Date();
  let from = input.from ? new Date(input.from) : new Date(to);
  if (!input.from) {
    if (input.range === 'year') from = reportPeriodStart(to, 'year');
    else if (input.range === 'today') from = reportPeriodStart(to, 'today');
    else
      from = new Date(
        to.getTime() - Number(input.range === 'custom' ? '30' : input.range) * 86400_000,
      );
  }
  ensure(
    from < to && to.getTime() - from.getTime() <= 3 * 366 * 86400_000,
    422,
    'INVALID_RANGE',
    'Choose a valid range up to three years',
  );
  return { from, to };
}
export async function analytics(
  actor: ReturnType<typeof actorOf>,
  input: z.infer<typeof rangeInput>,
) {
  if (actor.role === 'staff') permit(actor, 'reports:read');
  const { from, to } = reportRange(input);
  const scope = await resourceScope(actor);
  const customerFilter = await customerScope(actor);
  const [
    customers,
    totalSubs,
    active,
    invoices,
    payments,
    revenue,
    products,
    plans,
    customerGrowth,
    subscriptionGrowth,
  ] = await Promise.all([
    Customer.countDocuments(customerFilter),
    Subscription.countDocuments(scope),
    Subscription.find({ ...scope, status: 'active' })
      .select('subtotalMinor discountMinor frequency')
      .lean(),
    Invoice.aggregate([
      { $match: { ...scope, status: 'confirmed' } },
      {
        $group: {
          _id: null,
          outstandingMinor: {
            $sum: {
              $max: [0, { $subtract: ['$totalMinor', { $add: ['$paidMinor', '$creditedMinor'] }] }],
            },
          },
          overdue: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $lt: ['$dueAt', new Date()] },
                    {
                      $gt: [
                        { $subtract: ['$totalMinor', { $add: ['$paidMinor', '$creditedMinor'] }] },
                        0,
                      ],
                    },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
    Payment.aggregate([
      { $match: { ...scope, paidAt: { $gte: from, $lt: to } } },
      { $group: { _id: '$status', amountMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
    ]),
    Invoice.aggregate([
      { $match: { ...scope, status: 'confirmed', issuedAt: { $gte: from, $lt: to } } },
      {
        $group: {
          _id: { $dateToString: { date: '$issuedAt', format: '%Y-%m', timezone: 'Asia/Kolkata' } },
          invoicedMinor: { $sum: { $subtract: ['$totalMinor', '$creditedMinor'] } },
          preTaxMinor: {
            $sum: {
              $subtract: [
                { $subtract: ['$subtotalMinor', '$discountMinor'] },
                '$creditedPreTaxMinor',
              ],
            },
          },
          taxMinor: { $sum: { $subtract: ['$taxMinor', '$creditedTaxMinor'] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Invoice.aggregate([
      { $match: { ...scope, status: 'confirmed', issuedAt: { $gte: from, $lt: to } } },
      { $unwind: '$lines' },
      {
        $group: {
          _id: '$lines.productId',
          name: { $first: '$lines.name' },
          amountMinor: { $sum: { $subtract: ['$lines.baseMinor', '$lines.discountMinor'] } },
        },
      },
      { $sort: { amountMinor: -1 } },
      { $limit: 20 },
    ]),
    Invoice.aggregate([
      { $match: { ...scope, status: 'confirmed', issuedAt: { $gte: from, $lt: to } } },
      {
        $group: {
          _id: '$planId',
          name: { $first: '$planName' },
          amountMinor: { $sum: { $subtract: ['$subtotalMinor', '$discountMinor'] } },
        },
      },
      { $sort: { amountMinor: -1 } },
      { $limit: 20 },
    ]),
    Customer.aggregate([
      { $match: { ...customerFilter, createdAt: { $gte: from, $lt: to } } },
      {
        $group: {
          _id: { $dateToString: { date: '$createdAt', format: '%Y-%m', timezone: 'Asia/Kolkata' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Subscription.aggregate([
      { $match: { ...scope, createdAt: { $gte: from, $lt: to } } },
      {
        $group: {
          _id: { $dateToString: { date: '$createdAt', format: '%Y-%m', timezone: 'Asia/Kolkata' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);
  const adjustedInvoices = await Invoice.find({
    ...scope,
    status: 'confirmed',
    issuedAt: { $gte: from, $lt: to },
    creditedPreTaxMinor: { $gt: 0 },
  })
    .select('lines creditedPreTaxMinor planId')
    .lean();
  for (const invoice of adjustedInvoices) {
    if (invoice.lines.length) {
      const allocation = allocateMinor(
        invoice.creditedPreTaxMinor,
        invoice.lines.map((line) => line.baseMinor - line.discountMinor),
      );
      for (let index = 0; index < invoice.lines.length; index++) {
        const group = products.find(
          (product) => String(product._id) === String(invoice.lines[index]!.productId),
        );
        if (group) group.amountMinor -= allocation[index]!;
      }
    }
    const group = plans.find((plan) => String(plan._id) === String(invoice.planId ?? null));
    if (group) group.amountMinor -= invoice.creditedPreTaxMinor;
  }
  const cashTrend = await Payment.aggregate([
    { $match: { ...scope, status: 'captured', paidAt: { $gte: from, $lt: to } } },
    {
      $group: {
        _id: { $dateToString: { date: '$paidAt', format: '%Y-%m', timezone: 'Asia/Kolkata' } },
        collectedMinor: { $sum: '$amountMinor' },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  const { mrrMinor, arrMinor } = recurringRevenue(
    active.map((sub) => ({
      amountMinor: Math.max(0, sub.subtotalMinor - sub.discountMinor),
      frequency: sub.frequency,
    })),
  );
  const captured = payments.find((row) => row._id === 'captured');
  const failed = payments.find((row) => row._id === 'failed');
  const successRate =
    ((captured?.count ?? 0) / Math.max(1, (captured?.count ?? 0) + (failed?.count ?? 0))) * 100;
  const subIds = await Subscription.find(scope).distinct('_id');
  const events = await SubscriptionEvent.find({
    subscriptionId: { $in: subIds },
    effectiveAt: { $lt: to },
  })
    .sort({ effectiveAt: 1, createdAt: 1 })
    .lean();
  const atStart = new Map<string, string>();
  for (const event of events)
    if (event.effectiveAt < from) atStart.set(String(event.subscriptionId), event.to ?? '');
  const startActive = [...atStart.values()].filter((state) => state === 'active').length;
  const cancelledIds = new Set(
    events
      .filter(
        (event) =>
          event.effectiveAt >= from &&
          atStart.get(String(event.subscriptionId)) === 'active' &&
          ['cancelled', 'closed'].includes(event.to ?? ''),
      )
      .map((event) => String(event.subscriptionId)),
  );
  const renewed = await Subscription.find({
    ...scope,
    predecessorId: { $in: [...cancelledIds] },
    startAt: { $lt: to },
  }).distinct('predecessorId');
  for (const predecessor of renewed) cancelledIds.delete(String(predecessor));
  const cancelled = cancelledIds.size;
  const monthlyMrr: { month: string; mrrMinor: number }[] = [];
  const boundaries = reportMonths(from, to);
  for (const month of boundaries) {
    const end = month.until;
    const states = new Map<string, (typeof events)[number]>();
    for (const event of events)
      if (event.effectiveAt < end && event.effectiveAt < to)
        states.set(String(event.subscriptionId), event);
    monthlyMrr.push({
      month: month.label,
      mrrMinor: recurringRevenue(
        [...states.values()]
          .filter((event) => event.to === 'active')
          .map((event) => ({
            amountMinor: event.recurringMinor ?? 0,
            frequency: event.frequency ?? 'monthly',
          })),
      ).mrrMinor,
    });
  }
  const ledger = await Invoice.find({
    ...scope,
    issuedAt: { $lt: to },
    $or: [{ status: 'confirmed' }, { status: 'cancelled', billingRecordId: { $exists: true } }],
  })
    .select('_id issuedAt totalMinor status cancelledAt')
    .lean();
  const invoiceIds = ledger.map((row) => row._id);
  const [allocations, credits] = await Promise.all([
    PaymentAllocation.find({ invoiceId: { $in: invoiceIds }, createdAt: { $lt: to } })
      .select('invoiceId amountMinor createdAt')
      .lean(),
    CreditNote.find({ invoiceId: { $in: invoiceIds }, createdAt: { $lt: to } })
      .select('invoiceId amountMinor createdAt')
      .lean(),
  ]);
  const outstandingTrend = monthlyMrr.map((row) => {
    const cutoff = new Date(
      Math.min(
        boundaries.find((point) => point.label === row.month)!.until.getTime(),
        to.getTime(),
      ),
    );
    const valid = ledger.filter(
      (invoice) =>
        invoice.issuedAt < cutoff &&
        (invoice.status !== 'cancelled' || (invoice.cancelledAt && invoice.cancelledAt >= cutoff)),
    );
    const validIds = new Set(valid.map((invoice) => String(invoice._id)));
    const gross = valid.reduce((sum, invoice) => sum + invoice.totalMinor, 0);
    const paid = allocations
      .filter((a) => validIds.has(String(a.invoiceId)) && a.createdAt < cutoff)
      .reduce((sum, a) => sum + a.amountMinor, 0);
    const credited = credits
      .filter((c) => validIds.has(String(c.invoiceId)) && c.createdAt < cutoff)
      .reduce((sum, c) => sum + c.amountMinor, 0);
    return { month: row.month, outstandingMinor: Math.max(0, gross - paid - credited) };
  });
  return {
    outstandingTrend,
    metrics: {
      totalCustomers: customers,
      totalSubscriptions: totalSubs,
      activeSubscriptions: active.length,
      mrrMinor,
      arrMinor,
      collectedMinor: captured?.amountMinor ?? 0,
      outstandingMinor: invoices[0]?.outstandingMinor ?? 0,
      overdueInvoices: invoices[0]?.overdue ?? 0,
      paymentSuccessRate: successRate,
      churnRate: startActive ? (cancelled / startActive) * 100 : 0,
    },
    revenue,
    cashTrend,
    monthlyMrr,
    customerGrowth,
    subscriptionGrowth,
    paymentOutcomes: payments,
    revenueByProduct: products,
    revenueByPlan: plans,
    range: { from: from.toISOString(), to: to.toISOString(), timezone: 'Asia/Kolkata' },
    definitions: {
      cash: 'Captured payments by payment date',
      invoiced: 'Confirmed invoice totals less credits; tax shown separately',
      mrr: 'Active pre-tax recurring value normalized monthly; excludes paused contracts',
      churn: 'Unique closures in period divided by active contracts at period start',
    },
  };
}
export function analyticsRoutes(config: AuthConfig, redis?: Redis) {
  const router = Router();
  router.use(async (req, res, next) => {
    res.locals.actor ??= await authenticate(req.get('authorization'), config);
    next();
  });
  for (const path of [
    'dashboard',
    'revenue',
    'subscriptions',
    'payments',
    'customers',
    'outstanding',
  ])
    router.get(`/analytics/${path}`, async (req, res) =>
      res.json({
        data: await cachedAnalytics(redis, actorOf(res), rangeInput.parse(req.query), () =>
          analytics(actorOf(res), rangeInput.parse(req.query)),
        ),
      }),
    );
  router.get('/reports/export', async (req, res) => {
    const actor = actorOf(res);
    if (actor.role === 'staff') permit(actor, 'reports:read');
    const data = await analytics(actor, rangeInput.parse(req.query));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="subscriptiq-metrics.csv"');
    res.send(
      'metric,value\n' +
        Object.entries(data.metrics)
          .map(([key, value]) => `${key},${value}`)
          .join('\n'),
    );
  });
  return router;
}

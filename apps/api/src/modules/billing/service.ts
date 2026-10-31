import mongoose from 'mongoose';
import { nextBillingDate, anchorFor, type Frequency, type PriceLine } from '@subscriptiq/domain';
import {
  Subscription,
  BillingRecord,
  Invoice,
  Customer,
  Discount,
  DiscountUsage,
  SubscriptionEvent,
  SystemSetting,
} from '../../models/index.js';
import { audit, notify, numberFor } from '../../services/context.js';
import { priceLines, pricePlan } from '../../services/pricing.js';
import { ensure } from '../../lib/errors.js';
import { retireDrafts } from '../invoices/service.js';
export async function billCycle(subscriptionId: string, cycle: Date, now = new Date()) {
  const cycleKey = `${subscriptionId}-${cycle.getTime()}`;
  const existing = await BillingRecord.findOne({ cycleKey });
  if (existing) return existing.invoiceId;
  try {
    return await mongoose.connection.transaction(async (session) => {
      const sub = await Subscription.findById(subscriptionId).session(session);
      ensure(sub, 404, 'NOT_FOUND', 'Subscription not found');
      ensure(
        sub.status === 'active' && sub.nextBillingAt.getTime() === cycle.getTime() && cycle <= now,
        409,
        'NOT_DUE',
        'This subscription cycle is not eligible',
      );
      const close =
        (sub.cancelAt && sub.cancelAt <= cycle) || (sub.expiryAt && sub.expiryAt <= cycle);
      if (close || (sub.pauseAt && sub.pauseAt <= cycle)) {
        await retireDrafts(
          String(sub._id),
          session,
          'Subscription reached a non-billable boundary',
        );
        const before = sub.status;
        sub.status = close
          ? sub.cancelAt
            ? 'cancelled'
            : sub.planSnapshot?.autoClose
              ? 'closed'
              : 'paused'
          : 'paused';
        await sub.save({ session });
        await SubscriptionEvent.create(
          [
            {
              subscriptionId: sub._id,
              action: 'boundary',
              from: before,
              to: sub.status,
              effectiveAt: cycle,
            },
          ],
          { session },
        );
        await audit(
          undefined,
          'boundary',
          'Subscription',
          sub._id,
          { status: sub.status },
          session,
        );
        const customer = await Customer.findById(sub.customerId).session(session);
        await notify(
          customer!.email,
          `Subscription ${sub.status}`,
          `Subscription ${sub.number} is now ${sub.status}.`,
          `boundary-${sub._id}-${cycle.getTime()}`,
          session,
        );
        return undefined;
      }
      if (sub.pendingPlanId) {
        const pricing = await pricePlan(
          String(sub.pendingPlanId),
          sub.lines[0]!.quantity,
          {},
          session,
          cycle,
        );
        sub.planId = pricing.plan._id;
        sub.frequency = pricing.plan.frequency;
        Object.assign(sub, anchorFor(cycle, sub.billingTimezone));
        sub.planSnapshot = {
          name: pricing.plan.name,
          allowPause: pricing.plan.allowPause,
          allowEarlyClosure: pricing.plan.allowEarlyClosure,
          allowRenewal: pricing.plan.allowRenewal,
          autoClose: pricing.plan.autoClose,
        };
        sub.set('lines', pricing.lines);
        sub.set('pendingPlanId', undefined);
      }
      const next = nextBillingDate(
        cycle,
        sub.frequency as Frequency,
        sub.billingTimezone,
        sub.anchorDay,
        sub.anchorMonth,
      );
      const cycleEnd = sub.expiryAt && sub.expiryAt < next ? sub.expiryAt : next;
      const pricing = await priceLines(
        sub.lines.map((line) => ({
          productId: String(line.productId),
          variantId: line.variantId ? String(line.variantId) : undefined,
          name: line.name,
          quantity: line.quantity,
          unitPriceMinor: line.unitPriceMinor,
        })),
        cycle,
        session,
      );
      const customer = await Customer.findById(sub.customerId).session(session);
      ensure(customer, 409, 'CUSTOMER_MISSING', 'Customer is unavailable');
      const [record] = await BillingRecord.create(
        [{ subscriptionId: sub._id, cycleStart: cycle, cycleEnd, cycleKey }],
        { session },
      );
      const settings = await SystemSetting.findOne({ key: 'business' }).session(session);
      const draft = await Invoice.findOne({ cycleKey }).session(session);
      ensure(
        !draft || draft.status === 'draft',
        409,
        'INVOICE_FINALIZED',
        'This cycle already has a finalized invoice',
      );
      const invoiceData = {
        companySnapshot: {
          name: settings?.value?.companyName ?? 'Brightloop Software',
          footer: settings?.value?.invoiceFooter ?? '',
        },
        number: draft?.number ?? (await numberFor('INV', session)),
        cycleKey,
        cycleStart: cycle,
        customerId: sub.customerId,
        subscriptionId: sub._id,
        planId: sub.planId,
        planName: sub.planSnapshot?.name,
        billingRecordId: record!._id,
        customerSnapshot: {
          name: customer.name,
          email: customer.email,
          company: customer.company,
          address: customer.address,
          taxId: customer.taxId,
        },
        issuedAt: cycle,
        dueAt: new Date(cycle.getTime() + sub.paymentTermsDays * 86400_000),
        lines: pricing.lines,
        subtotalMinor: pricing.subtotalMinor,
        discountMinor: pricing.discountMinor,
        taxMinor: pricing.taxMinor,
        totalMinor: pricing.totalMinor,
        status: 'confirmed' as const,
      };
      let invoice;
      if (draft) {
        draft.set(invoiceData);
        await draft.save({ session });
        invoice = draft;
      } else {
        const created = await Invoice.create([invoiceData], { session });
        invoice = created[0]!;
      }
      if (pricing.discountId) {
        const reserved = await Discount.updateOne(
          {
            _id: pricing.discountId,
            $or: [
              { maxRedemptions: { $exists: false } },
              { $expr: { $lt: ['$usedCount', '$maxRedemptions'] } },
            ],
          },
          { $inc: { usedCount: 1 } },
          { session },
        );
        ensure(
          reserved.modifiedCount === 1,
          409,
          'DISCOUNT_EXHAUSTED',
          'Discount eligibility changed; retry billing',
        );
        await DiscountUsage.create(
          [
            {
              discountId: pricing.discountId,
              invoiceId: invoice!._id,
              subscriptionId: sub._id,
              amountMinor: pricing.discountMinor,
              redemptionKey: `${pricing.discountId}-${invoice!._id}`,
            },
          ],
          { session },
        );
      }
      record!.invoiceId = invoice!._id;
      await record!.save({ session });
      await SubscriptionEvent.create(
        [
          {
            subscriptionId: sub._id,
            action: 'billed',
            from: 'active',
            to: 'active',
            recurringMinor: pricing.subtotalMinor - pricing.discountMinor,
            frequency: sub.frequency,
            effectiveAt: cycle,
          },
        ],
        { session },
      );
      sub.nextBillingAt = next;
      sub.subtotalMinor = pricing.subtotalMinor;
      sub.discountMinor = pricing.discountMinor;
      sub.taxMinor = pricing.taxMinor;
      sub.totalMinor = pricing.totalMinor;
      await sub.save({ session });
      await audit(
        undefined,
        'billed',
        'Subscription',
        sub._id,
        { invoiceId: invoice!._id, cycleKey },
        session,
      );
      await notify(
        customer.email,
        `Invoice ${invoice!.number}`,
        `Invoice ${invoice!.number} for INR ${(invoice!.totalMinor / 100).toFixed(2)} is due ${invoice!.dueAt.toISOString()}. Sign in to view and pay.`,
        `invoice-${invoice!._id}`,
        session,
      );
      return invoice!._id;
    });
  } catch (error) {
    const completed = await BillingRecord.findOne({ cycleKey });
    if (completed) return completed.invoiceId;
    throw error;
  }
}

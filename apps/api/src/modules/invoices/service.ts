import mongoose from 'mongoose';
import { Invoice, Subscription, Customer, SystemSetting } from '../../models/index.js';
import { ensure } from '../../lib/errors.js';
import { priceLines, pricePlan } from '../../services/pricing.js';
import { audit, numberFor, resourceScope, permit, type Actor } from '../../services/context.js';
export async function retireDrafts(
  subscriptionId: string,
  session: mongoose.ClientSession,
  reason: string,
) {
  const drafts = await Invoice.find({ subscriptionId, status: 'draft' }).session(session);
  for (const draft of drafts) {
    draft.status = 'cancelled';
    draft.cancelledAt = new Date();
    draft.set('cycleKey', undefined);
    await draft.save({ session });
    await audit(undefined, 'draft_retired', 'Invoice', draft._id, { reason }, session);
  }
}
export async function previewInvoice(actor: Actor, subscriptionId: string) {
  permit(actor, 'invoices:write');
  return mongoose.connection.transaction(async (session) => {
    const sub = await Subscription.findOne({
      _id: subscriptionId,
      ...(await resourceScope(actor)),
      status: 'active',
    }).session(session);
    ensure(sub, 409, 'INVALID_STATE', 'Only an active subscription can preview its next invoice');
    const cycle = sub.nextBillingAt;
    ensure(!sub.expiryAt || sub.expiryAt > cycle, 409, 'EXPIRED', 'No billable period remains');
    ensure(
      !sub.cancelAt && !sub.pauseAt,
      409,
      'SCHEDULED_CHANGE',
      'Resume or resolve the scheduled closure/pause before previewing another invoice',
    );
    const cycleKey = `${sub._id}-${cycle.getTime()}`;
    const existing = await Invoice.findOne({ cycleKey }).session(session);
    if (existing) return existing;
    let pricing: Awaited<ReturnType<typeof priceLines>>;
    let planName = sub.planSnapshot?.name;
    if (sub.pendingPlanId) {
      const proposed = await pricePlan(
        String(sub.pendingPlanId),
        sub.lines[0]!.quantity,
        {},
        session,
        cycle,
      );
      pricing = proposed;
      planName = proposed.plan.name;
    } else
      pricing = await priceLines(
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
    ensure(customer, 409, 'CUSTOMER_MISSING', 'Customer not found');
    const settings = await SystemSetting.findOne({ key: 'business' }).session(session);
    const [invoice] = await Invoice.create(
      [
        {
          number: await numberFor('INV', session),
          cycleKey,
          cycleStart: cycle,
          customerId: sub.customerId,
          subscriptionId: sub._id,
          planId: sub.pendingPlanId ?? sub.planId,
          planName,
          companySnapshot: {
            name: settings?.value?.companyName ?? 'Brightloop Software',
            footer: settings?.value?.invoiceFooter ?? '',
          },
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
          status: 'draft',
        },
      ],
      { session },
    );
    const locked = await Subscription.updateOne(
      { _id: sub._id, __v: sub.__v },
      { $inc: { __v: 1 } },
      { session },
    );
    ensure(
      locked.modifiedCount === 1,
      409,
      'VERSION_CONFLICT',
      'Subscription changed; retry the preview',
    );
    await audit(actor, 'drafted', 'Invoice', invoice!._id, undefined, session);
    return invoice!;
  });
}
export async function cancelInvoice(actor: Actor, id: string, reason: string) {
  permit(actor, 'invoices:write');
  return mongoose.connection.transaction(async (session) => {
    const invoice = await Invoice.findOne({ _id: id, ...(await resourceScope(actor)) }).session(
      session,
    );
    ensure(
      invoice &&
        invoice.status !== 'cancelled' &&
        invoice.paidMinor === 0 &&
        invoice.creditedMinor === 0,
      409,
      'INVALID_STATE',
      'Paid, credited or cancelled invoices cannot be cancelled',
    );
    const before = invoice.status;
    if (before === 'draft') invoice.set('cycleKey', undefined);
    invoice.status = 'cancelled';
    invoice.cancelledAt = new Date();
    await invoice.save({ session });
    await audit(actor, 'cancelled', 'Invoice', invoice._id, { reason }, session, {
      status: before,
    });
    return invoice;
  });
}

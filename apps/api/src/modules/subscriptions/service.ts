import mongoose, { type ClientSession } from 'mongoose';
import { z } from 'zod';
import { anchorFor, assertTransition, roundRatio } from '@subscriptiq/domain';
import {
  Quotation,
  QuotationTemplate,
  Subscription,
  SubscriptionEvent,
  Customer,
  Plan,
  ChangeRequest,
  SystemSetting,
} from '../../models/index.js';
import { ensure } from '../../lib/errors.js';
import { retireDrafts } from '../invoices/service.js';
import {
  audit,
  notify,
  numberFor,
  ownedCustomer,
  permit,
  resourceScope,
  type Actor,
} from '../../services/context.js';
import { pricePlan } from '../../services/pricing.js';
import { id, quantity, date } from '../catalog/schemas.js';
export const orderInput = z
  .object({
    customerId: id,
    planId: id,
    quantity,
    variants: z.record(id, id).default({}),
    startAt: date.optional(),
    expiryAt: date.optional(),
    paymentTermsDays: z.number().int().min(0).max(365).optional(),
    billingTimezone: z
      .string()
      .default('Asia/Kolkata')
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, 'Invalid timezone'),
  })
  .strict()
  .refine((v) => !v.expiryAt || v.expiryAt > (v.startAt ?? new Date()), {
    path: ['expiryAt'],
    message: 'Expiry must follow start',
  });
export const quotationInput = z
  .object({
    customerId: id,
    planId: id.optional(),
    templateId: id.optional(),
    quantity: quantity.optional(),
    variants: z.record(id, id).default({}),
    expiryAt: date,
    terms: z.string().max(4000).default(''),
  })
  .strict()
  .refine((v) => Boolean(v.planId || v.templateId), {
    message: 'Choose a plan or template',
    path: ['planId'],
  });
function snapshot(plan: {
  name: string;
  allowPause: boolean;
  allowEarlyClosure: boolean;
  allowRenewal: boolean;
  autoClose: boolean;
}) {
  return {
    name: plan.name,
    allowPause: plan.allowPause,
    allowEarlyClosure: plan.allowEarlyClosure,
    allowRenewal: plan.allowRenewal,
    autoClose: plan.autoClose,
  };
}
export async function createQuotation(actor: Actor, input: z.infer<typeof quotationInput>) {
  if (actor.role === 'staff') permit(actor, 'quotations:write');
  await ownedCustomer(actor, input.customerId);
  ensure(input.expiryAt > new Date(), 422, 'EXPIRY', 'Quotation expiry must be in the future');
  return mongoose.connection.transaction(async (session) => {
    const template = input.templateId
      ? await QuotationTemplate.findOne({ _id: input.templateId, active: true }).session(session)
      : undefined;
    ensure(!input.templateId || template, 422, 'INVALID_TEMPLATE', 'Template unavailable');
    const planId = input.planId ?? String(template!.planId);
    const pricing = await pricePlan(
      planId,
      input.quantity ?? template?.quantity ?? 1,
      input.variants,
      session,
    );
    const [quote] = await Quotation.create(
      [
        {
          number: await numberFor('QUO', session),
          customerId: input.customerId,
          planId,
          templateId: input.templateId,
          expiryAt: input.expiryAt,
          terms: input.terms || template?.terms,
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
    await audit(actor, 'created', 'Quotation', quote!._id, undefined, session);
    return quote!;
  });
}
export async function quotationAction(
  actor: Actor,
  id: string,
  action: 'send' | 'accept' | 'reject',
) {
  if (actor.role === 'staff') permit(actor, 'quotations:write');
  return mongoose.connection.transaction(async (session) => {
    const quote = await Quotation.findOne({ _id: id, ...(await resourceScope(actor)) }).session(
      session,
    );
    ensure(quote, 404, 'NOT_FOUND', 'Quotation not found');
    ensure(quote.expiryAt > new Date(), 409, 'QUOTE_EXPIRED', 'Quotation has expired');
    const allowed = action === 'send' ? quote.status === 'draft' : quote.status === 'sent';
    ensure(allowed, 409, 'INVALID_STATE', 'Quotation does not allow this action');
    ensure(
      action !== 'send' || actor.role !== 'customer',
      403,
      'FORBIDDEN',
      'Only staff can send quotations',
    );
    quote.status = action === 'send' ? 'sent' : action === 'accept' ? 'accepted' : 'rejected';
    await quote.save({ session });
    const customer = await Customer.findById(quote.customerId).session(session);
    if (action === 'send')
      await notify(
        customer!.email,
        `Quotation ${quote.number}`,
        `Your quotation totals INR ${(quote.totalMinor / 100).toFixed(2)} and expires ${quote.expiryAt.toISOString()}. Sign in to review.`,
        `quote-${quote._id}-sent`,
        session,
      );
    await audit(actor, action, 'Quotation', quote._id, { status: quote.status }, session);
    return quote;
  });
}
export async function createSubscription(actor: Actor, input: z.infer<typeof orderInput>) {
  permit(actor, 'subscriptions:write');
  await ownedCustomer(actor, input.customerId);
  return mongoose.connection.transaction(async (session) => {
    const pricing = await pricePlan(input.planId, input.quantity, input.variants, session);
    const settings = await SystemSetting.findOne({ key: 'business' }).session(session);
    const startAt = input.startAt ?? new Date();
    const [sub] = await Subscription.create(
      [
        {
          ...input,
          paymentTermsDays: input.paymentTermsDays ?? settings?.value?.defaultTermsDays ?? 7,
          startAt,
          ...anchorFor(startAt, input.billingTimezone),
          number: await numberFor('SUB', session),
          nextBillingAt: startAt,
          planSnapshot: snapshot(pricing.plan),
          frequency: pricing.plan.frequency,
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
    await audit(actor, 'created', 'Subscription', sub!._id, undefined, session);
    return sub!;
  });
}
export async function convertQuotation(actor: Actor, id: string) {
  if (actor.role === 'staff') permit(actor, 'subscriptions:write');
  return mongoose.connection.transaction(async (session) => {
    const quote = await Quotation.findOne({ _id: id, ...(await resourceScope(actor)) }).session(
      session,
    );
    ensure(quote, 404, 'NOT_FOUND', 'Quotation not found');
    if (quote.convertedSubscriptionId)
      return await Subscription.findById(quote.convertedSubscriptionId).session(session);
    ensure(
      quote.status === 'accepted' && quote.expiryAt > new Date(),
      409,
      'INVALID_STATE',
      'Accept an unexpired quotation before conversion',
    );
    const { plan } = await pricePlan(String(quote.planId), quote.lines[0]!.quantity, {}, session);
    const startAt = new Date();
    const timezone = 'Asia/Kolkata';
    const settings = await SystemSetting.findOne({ key: 'business' }).session(session);
    const [sub] = await Subscription.create(
      [
        {
          number: await numberFor('SUB', session),
          customerId: quote.customerId,
          planId: quote.planId,
          sourceQuotationId: quote._id,
          paymentTermsDays: settings?.value?.defaultTermsDays ?? 7,
          startAt,
          nextBillingAt: startAt,
          ...anchorFor(startAt, timezone),
          billingTimezone: timezone,
          frequency: plan.frequency,
          planSnapshot: snapshot(plan),
          lines: quote.lines.toObject(),
          subtotalMinor: quote.subtotalMinor,
          discountMinor: quote.discountMinor,
          taxMinor: quote.taxMinor,
          totalMinor: quote.totalMinor,
          status: 'confirmed',
        },
      ],
      { session },
    );
    quote.convertedSubscriptionId = sub!._id;
    await quote.save({ session });
    await audit(actor, 'converted', 'Quotation', quote._id, { subscriptionId: sub!._id }, session);
    return sub!;
  });
}
export async function subscriptionAction(
  actor: Actor,
  id: string,
  action: string,
  reason: string,
  planId?: string,
) {
  if (actor.role === 'staff') permit(actor, 'subscriptions:write');
  return mongoose.connection.transaction(async (session) => {
    const sub = await Subscription.findOne({ _id: id, ...(await resourceScope(actor)) }).session(
      session,
    );
    ensure(sub, 404, 'NOT_FOUND', 'Subscription not found');
    const before = sub.status;
    const customer = await Customer.findById(sub.customerId).session(session);
    if (action === 'pause') {
      ensure(sub.planSnapshot?.allowPause, 409, 'PLAN_POLICY', 'This plan does not permit pausing');
      ensure(
        sub.status === 'active' && !sub.pauseAt && !sub.cancelAt,
        409,
        'INVALID_STATE',
        'Only an active subscription can be paused',
      );
      sub.pauseAt = sub.nextBillingAt;
    } else if (action === 'resume') {
      ensure(
        !sub.expiryAt || sub.expiryAt > new Date(),
        409,
        'EXPIRED',
        'Renew this expired subscription instead of resuming',
      );
      ensure(
        sub.planSnapshot?.allowPause,
        409,
        'PLAN_POLICY',
        'This plan does not permit pause/resume',
      );
      if (sub.status === 'active' && sub.pauseAt) sub.pauseAt = undefined;
      else {
        ensure(sub.status === 'paused', 409, 'INVALID_STATE', 'Subscription is not paused');
        sub.status = 'active';
        sub.nextBillingAt = new Date();
        sub.pauseAt = undefined;
      }
    } else if (action === 'cancel') {
      ensure(
        actor.role !== 'customer',
        403,
        'REQUEST_REQUIRED',
        'Submit a cancellation request for review',
      );
      ensure(
        ['active', 'paused', 'confirmed'].includes(sub.status),
        409,
        'INVALID_STATE',
        'Subscription cannot be cancelled',
      );
      if (sub.status === 'active') sub.cancelAt = sub.nextBillingAt;
      else sub.status = 'cancelled';
    } else if (action === 'upgrade' || action === 'downgrade') {
      ensure(
        actor.role !== 'customer',
        403,
        'REQUEST_REQUIRED',
        'Submit a plan-change request for review',
      );
      ensure(
        sub.status === 'active' && !sub.cancelAt,
        409,
        'INVALID_STATE',
        'Only active subscriptions can change plans',
      );
      ensure(planId, 422, 'PLAN_REQUIRED', 'Choose a target plan');
      const target = await pricePlan(planId, sub.lines[0]!.quantity, {}, session);
      const monthly = (price: number, frequency: string) =>
        roundRatio(
          price,
          frequency === 'daily'
            ? 365
            : frequency === 'weekly'
              ? 52
              : frequency === 'yearly'
                ? 1
                : 12,
          frequency === 'yearly' ? 12 : frequency === 'monthly' ? 12 : 12,
        );
      const current = monthly(sub.subtotalMinor, sub.frequency);
      const next = monthly(target.subtotalMinor, target.plan.frequency);
      ensure(
        action === 'upgrade' ? next > current : next < current,
        422,
        'PLAN_DIRECTION',
        `Choose a ${action === 'upgrade' ? 'higher' : 'lower'} recurring value plan`,
      );
      sub.pendingPlanId = target.plan._id;
    } else if (action === 'renew') {
      const existingSuccessor = await Subscription.findOne({ predecessorId: sub._id }).session(
        session,
      );
      if (existingSuccessor) return existingSuccessor;
      ensure(sub.planSnapshot?.allowRenewal, 409, 'PLAN_POLICY', 'Renewal is not permitted');
      ensure(
        ['closed', 'cancelled'].includes(sub.status) ||
          (sub.status === 'paused' && Boolean(sub.expiryAt && sub.expiryAt <= new Date())),
        409,
        'INVALID_STATE',
        'Renewal creates a successor after closure',
      );
      const pricing = await pricePlan(String(sub.planId), sub.lines[0]!.quantity, {}, session);
      const startAt = new Date();
      const [renewed] = await Subscription.create(
        [
          {
            number: await numberFor('SUB', session),
            customerId: sub.customerId,
            planId: sub.planId,
            predecessorId: sub._id,
            startAt,
            nextBillingAt: startAt,
            ...anchorFor(startAt, sub.billingTimezone),
            billingTimezone: sub.billingTimezone,
            frequency: pricing.plan.frequency,
            planSnapshot: snapshot(pricing.plan),
            paymentTermsDays: sub.paymentTermsDays,
            lines: pricing.lines,
            subtotalMinor: pricing.subtotalMinor,
            discountMinor: pricing.discountMinor,
            taxMinor: pricing.taxMinor,
            totalMinor: pricing.totalMinor,
            status: 'confirmed',
          },
        ],
        { session },
      );
      await audit(
        actor,
        'renewed',
        'Subscription',
        sub._id,
        { successorId: renewed!._id },
        session,
      );
      await notify(
        customer!.email,
        'Subscription renewed',
        `Successor subscription ${renewed!.number} is ready for activation.`,
        `renew-${renewed!._id}`,
        session,
      );
      return renewed!;
    } else {
      const target: Record<string, string> = {
        quote: 'quotation',
        confirm: 'confirmed',
        activate: 'active',
        close: 'closed',
      };
      const to = target[action];
      ensure(to, 404, 'NOT_FOUND', 'Unknown subscription action');
      if (actor.role === 'customer')
        ensure(
          action === 'activate' && sub.sourceQuotationId,
          403,
          'FORBIDDEN',
          'This action requires staff',
        );
      if (action === 'close')
        ensure(
          sub.planSnapshot?.allowEarlyClosure,
          409,
          'PLAN_POLICY',
          'Early closure is not permitted',
        );
      if (action === 'activate') {
        ensure(
          sub.startAt <= new Date(),
          409,
          'NOT_STARTED',
          'Subscription start date has not arrived',
        );
        ensure(!sub.expiryAt || sub.expiryAt > new Date(), 409, 'EXPIRED', 'Subscription expired');
      }
      try {
        assertTransition(sub.status, to);
      } catch {
        ensure(false, 409, 'INVALID_STATE', `Cannot ${action} a ${sub.status} subscription`);
      }
      sub.status = to as typeof sub.status;
    }
    if (['paused', 'closed', 'cancelled'].includes(sub.status))
      await retireDrafts(String(sub._id), session, 'Subscription is no longer billable');
    await sub.save({ session });
    await SubscriptionEvent.create(
      [
        {
          subscriptionId: sub._id,
          actorId: actor.id,
          action,
          from: before,
          to: sub.status,
          reason,
          recurringMinor: sub.subtotalMinor - sub.discountMinor,
          frequency: sub.frequency,
          effectiveAt: sub.pauseAt ?? sub.cancelAt ?? new Date(),
        },
      ],
      { session },
    );
    await audit(
      actor,
      action,
      'Subscription',
      sub._id,
      {
        from: before,
        to: sub.status,
        pauseAt: sub.pauseAt,
        cancelAt: sub.cancelAt,
        pendingPlanId: sub.pendingPlanId,
      },
      session,
    );
    await notify(
      customer!.email,
      `Subscription ${action}`,
      `Subscription ${sub.number}: ${action}${sub.pauseAt || sub.cancelAt ? ' scheduled at the next billing boundary' : ''}.`,
      `sub-${sub._id}-${sub.__v}-${action}`,
      session,
    );
    return sub;
  });
}

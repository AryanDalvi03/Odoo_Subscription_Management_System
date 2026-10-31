import { Router } from 'express';
import type { Model } from 'mongoose';
import { z } from 'zod';
import { authenticate, type AuthConfig } from '../auth/service.js';
import { actorOf, escapeRegex, listQuery } from '../catalog/routes.js';
import { objectId, permit, resourceScope, audit, ownedCustomer } from '../../services/context.js';
import { anchorFor } from '@subscriptiq/domain';
import {
  Quotation,
  Subscription,
  SubscriptionEvent,
  ChangeRequest,
  Customer,
} from '../../models/index.js';
import { ensure } from '../../lib/errors.js';
import * as service from './service.js';
import { pricePlan } from '../../services/pricing.js';
export function subscriptionRoutes(config: AuthConfig) {
  const router = Router();
  router.use(async (req, res, next) => {
    res.locals.actor ??= await authenticate(req.get('authorization'), config);
    res.locals.actor.ip = req.ip;
    const actor = actorOf(res);
    if (actor.role === 'staff' && /^\/(subscriptions|change-requests)/.test(req.path))
      permit(actor, 'subscriptions:write');
    if (actor.role === 'staff' && req.path.startsWith('/quotations'))
      permit(actor, 'quotations:write');
    next();
  });
  for (const [path, model] of [
    ['quotations', Quotation],
    ['subscriptions', Subscription],
  ] as const) {
    const collection = model as Model<unknown>;
    router.get(`/${path}`, async (req, res) => {
      const actor = actorOf(res);
      if (actor.role === 'staff') permit(actor, `${path}:write`);
      const query = listQuery.parse(req.query);
      const scope = {
        ...(await resourceScope(actor)),
        ...(query.status ? { status: query.status } : {}),
        ...(query.q ? { number: { $regex: escapeRegex(query.q), $options: 'i' } } : {}),
      };
      res.json({
        data: await collection
          .find(scope)
          .sort(query.sort)
          .skip((query.page - 1) * query.pageSize)
          .limit(query.pageSize),
        meta: {
          total: await collection.countDocuments(scope),
          page: query.page,
          pageSize: query.pageSize,
        },
      });
    });
    router.get(`/${path}/:id`, async (req, res) => {
      const row = await collection.findOne({
        _id: objectId(req.params.id),
        ...(await resourceScope(actorOf(res))),
      });
      ensure(row, 404, 'NOT_FOUND', 'Record not found');
      res.json({ data: row });
    });
  }
  router.post('/quotations', async (req, res) =>
    res.status(201).json({
      data: await service.createQuotation(actorOf(res), service.quotationInput.parse(req.body)),
    }),
  );
  for (const action of ['send', 'accept', 'reject'] as const)
    router.post(`/quotations/:id/${action}`, async (req, res) => {
      z.object({})
        .strict()
        .parse(req.body ?? {});
      res.json({
        data: await service.quotationAction(actorOf(res), objectId(req.params.id), action),
      });
    });
  router.patch('/quotations/:id', async (req, res) => {
    const actor = actorOf(res);
    permit(actor, 'quotations:write');
    const body = z
      .object({
        expiryAt: z.iso.datetime().transform((v) => new Date(v)),
        terms: z.string().max(4000),
        planId: z
          .string()
          .regex(/^[a-f\d]{24}$/i)
          .optional(),
        quantity: z.number().int().min(1).max(100000).optional(),
        variants: z.record(z.string(), z.string().regex(/^[a-f\d]{24}$/i)).optional(),
      })
      .strict()
      .parse(req.body);
    ensure(body.expiryAt > new Date(), 422, 'EXPIRY', 'Choose a future expiry');
    const previous = await Quotation.findOne({
      _id: objectId(req.params.id),
      status: 'draft',
      ...(await resourceScope(actor)),
    });
    ensure(previous, 409, 'INVALID_STATE', 'Only draft quotations may be edited');
    const repriced =
      body.planId || body.quantity || body.variants
        ? await pricePlan(
            body.planId ?? String(previous.planId),
            body.quantity ?? previous.lines[0]!.quantity,
            body.variants ?? {},
          )
        : undefined;
    const update = {
      expiryAt: body.expiryAt,
      terms: body.terms,
      ...(repriced
        ? {
            planId: repriced.plan._id,
            lines: repriced.lines,
            subtotalMinor: repriced.subtotalMinor,
            discountMinor: repriced.discountMinor,
            taxMinor: repriced.taxMinor,
            totalMinor: repriced.totalMinor,
          }
        : {}),
    };
    const row = await Quotation.findOneAndUpdate(
      {
        _id: objectId(req.params.id),
        status: 'draft',
        __v: previous.__v,
        ...(await resourceScope(actor)),
      },
      { $set: update, $inc: { __v: 1 } },
      { returnDocument: 'after' },
    );
    ensure(row, 409, 'INVALID_STATE', 'Only available draft quotations can be edited');
    await audit(actor, 'edited', 'Quotation', row._id, body);
    res.json({ data: row });
  });
  router.post('/quotations/:id/convert', async (req, res) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    res.json({ data: await service.convertQuotation(actorOf(res), objectId(req.params.id)) });
  });
  router.post('/subscriptions', async (req, res) =>
    res.status(201).json({
      data: await service.createSubscription(actorOf(res), service.orderInput.parse(req.body)),
    }),
  );
  router.patch('/subscriptions/:id', async (req, res) => {
    const actor = actorOf(res);
    permit(actor, 'subscriptions:write');
    const data = service.orderInput.parse(req.body);
    await ownedCustomer(actor, data.customerId);
    const pricing = await pricePlan(data.planId, data.quantity, data.variants);
    const row = await Subscription.findOneAndUpdate(
      { _id: objectId(req.params.id), status: 'draft', ...(await resourceScope(actor)) },
      {
        $set: {
          customerId: data.customerId,
          startAt: data.startAt ?? new Date(),
          nextBillingAt: data.startAt ?? new Date(),
          billingTimezone: data.billingTimezone,
          ...anchorFor(data.startAt ?? new Date(), data.billingTimezone),
          planSnapshot: {
            name: pricing.plan.name,
            allowPause: pricing.plan.allowPause,
            allowEarlyClosure: pricing.plan.allowEarlyClosure,
            allowRenewal: pricing.plan.allowRenewal,
            autoClose: pricing.plan.autoClose,
          },
          planId: data.planId,
          paymentTermsDays: data.paymentTermsDays,
          expiryAt: data.expiryAt,
          lines: pricing.lines,
          subtotalMinor: pricing.subtotalMinor,
          discountMinor: pricing.discountMinor,
          taxMinor: pricing.taxMinor,
          totalMinor: pricing.totalMinor,
          frequency: pricing.plan.frequency,
        },
        $inc: { __v: 1 },
      },
      { returnDocument: 'after' },
    );
    ensure(row, 409, 'INVALID_STATE', 'Only available draft subscriptions may be edited');
    await audit(actor, 'edited', 'Subscription', row._id);
    res.json({ data: row });
  });
  for (const action of [
    'quote',
    'confirm',
    'activate',
    'pause',
    'resume',
    'cancel',
    'close',
    'renew',
    'upgrade',
    'downgrade',
  ])
    router.post(`/subscriptions/:id/${action}`, async (req, res) => {
      const body = z
        .object({
          reason: z.string().max(2000).default(''),
          planId: z
            .string()
            .regex(/^[a-f\d]{24}$/i)
            .optional(),
        })
        .strict()
        .parse(req.body ?? {});
      res.json({
        data: await service.subscriptionAction(
          actorOf(res),
          objectId(req.params.id),
          action,
          body.reason,
          body.planId,
        ),
      });
    });
  router.get('/subscriptions/:id/history', async (req, res) => {
    ensure(
      await Subscription.exists({
        _id: objectId(req.params.id),
        ...(await resourceScope(actorOf(res))),
      }),
      404,
      'NOT_FOUND',
      'Subscription not found',
    );
    res.json({
      data: await SubscriptionEvent.find({ subscriptionId: req.params.id })
        .sort('-createdAt')
        .limit(100),
    });
  });
  router.post('/subscriptions/:id/change-requests', async (req, res) => {
    const actor = actorOf(res);
    const sub = await Subscription.findOne({
      _id: objectId(req.params.id),
      ...(await resourceScope(actor)),
    });
    ensure(sub, 404, 'NOT_FOUND', 'Subscription not found');
    ensure(
      ['active', 'paused', 'confirmed'].includes(sub.status),
      409,
      'INVALID_STATE',
      'Subscription cannot be changed',
    );
    const body = z
      .object({
        kind: z.enum(['cancel', 'upgrade', 'downgrade']),
        planId: z
          .string()
          .regex(/^[a-f\d]{24}$/i)
          .optional(),
        reason: z.string().min(3).max(2000),
      })
      .strict()
      .parse(req.body);
    ensure(body.kind === 'cancel' || body.planId, 422, 'PLAN_REQUIRED', 'Choose a target plan');
    ensure(
      !(await ChangeRequest.exists({ subscriptionId: sub._id, status: 'pending' })),
      409,
      'REQUEST_PENDING',
      'A request is already pending',
    );
    const row = await ChangeRequest.create({
      ...body,
      customerId: sub.customerId,
      subscriptionId: sub._id,
    });
    await audit(actor, 'requested', 'ChangeRequest', row._id, body);
    res.status(201).json({ data: row });
  });
  router.get('/change-requests', async (_req, res) =>
    res.json({
      data: await ChangeRequest.find(await resourceScope(actorOf(res)))
        .sort('-createdAt')
        .limit(100),
    }),
  );
  for (const decision of ['approve', 'reject'] as const)
    router.post(`/change-requests/:id/${decision}`, async (req, res) => {
      const actor = actorOf(res);
      permit(actor, 'subscriptions:write');
      const row = await ChangeRequest.findOne({
        _id: objectId(req.params.id),
        status: 'pending',
        ...(await resourceScope(actor)),
      });
      ensure(row, 404, 'NOT_FOUND', 'Pending request not found');
      if (decision === 'approve')
        await service.subscriptionAction(
          actor,
          String(row.subscriptionId),
          row.kind,
          row.reason ?? '',
          row.planId ? String(row.planId) : undefined,
        );
      row.status = decision === 'approve' ? 'approved' : 'rejected';
      row.reviewedBy = new (await import('mongoose')).Types.ObjectId(actor.id);
      await row.save();
      await audit(actor, decision, 'ChangeRequest', row._id);
      res.json({ data: row });
    });
  return router;
}

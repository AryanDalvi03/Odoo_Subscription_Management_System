import { Router, type Response } from 'express';
import type { Model } from 'mongoose';
import { z } from 'zod';
import argon2 from 'argon2';
import {
  Product,
  ProductVariant,
  Plan,
  Tax,
  Discount,
  Customer,
  QuotationTemplate,
  User,
  AuditLog,
  Notification,
  BillingRecord,
  SystemSetting,
} from '../../models/index.js';
import {
  authenticate,
  type AuthConfig,
  emailSchema,
  passwordSchema,
  publicUser,
} from '../auth/service.js';
import { audit, customerScope, permit, objectId, type Actor } from '../../services/context.js';
import { ensure } from '../../lib/errors.js';
import * as schemas from './schemas.js';
export const actorOf = (res: Response) => res.locals.actor as Actor;
export const listQuery = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    q: z.string().max(100).optional(),
    status: z.string().max(30).optional(),
    sort: z.enum(['createdAt', '-createdAt', 'name', '-name']).default('-createdAt'),
  })
  .strict();
export function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export function catalogRoutes(config: AuthConfig) {
  const router = Router();
  router.use(async (req, res, next) => {
    res.locals.actor ??= await authenticate(req.get('authorization'), config);
    res.locals.actor.ip = req.ip;
    next();
  });
  const resources = [
    ['products', Product, schemas.productInput],
    ['plans', Plan, schemas.planInput],
    ['taxes', Tax, schemas.taxInput],
    ['discounts', Discount, schemas.discountInput],
    ['quotation-templates', QuotationTemplate, schemas.templateInput],
  ] as const;
  for (const [path, model, schema] of resources) {
    // The model operations here share only transport mechanics; domain validation stays explicit below.
    const collection = model as Model<unknown>;
    const validateLinks = async (data: Record<string, unknown>) => {
      const ids =
        path === 'plans'
          ? (data.products as { productId: string }[]).map((p) => p.productId)
          : path === 'taxes' || path === 'discounts'
            ? (data.productIds as string[])
            : [];
      if (ids.length)
        ensure(
          (await Product.countDocuments({ _id: { $in: ids }, status: 'active' })) ===
            new Set(ids).size,
          422,
          'INVALID_PRODUCT',
          'Select active products',
        );
      if (path === 'quotation-templates')
        ensure(
          await Plan.exists({ _id: data.planId, status: 'active' }),
          422,
          'INVALID_PLAN',
          'Select an active plan',
        );
    };
    router.get(`/${path}`, async (req, res) => {
      const actor = actorOf(res);
      if (['taxes', 'discounts'].includes(path)) permit(actor, `${path}:read`);
      const query = listQuery.parse(req.query);
      const scope: Record<string, unknown> = {};
      if (actor.role === 'customer') {
        if (path === 'quotation-templates') scope.active = true;
        else scope.status = 'active';
        if (path === 'plans')
          scope.$and = [
            {
              $or: [{ availableFrom: { $exists: false } }, { availableFrom: { $lte: new Date() } }],
            },
            {
              $or: [
                { availableUntil: { $exists: false } },
                { availableUntil: { $gt: new Date() } },
              ],
            },
          ];
      } else if (query.status) scope.status = query.status;
      if (query.q) scope.name = { $regex: escapeRegex(query.q), $options: 'i' };
      const projection = actor.role !== 'admin' ? '-costPriceMinor -notes' : undefined;
      const [rows, total] = await Promise.all([
        collection
          .find(scope, projection)
          .sort(query.sort)
          .skip((query.page - 1) * query.pageSize)
          .limit(query.pageSize)
          .lean(),
        collection.countDocuments(scope),
      ]);
      res.json({ data: rows, meta: { total, page: query.page, pageSize: query.pageSize } });
    });
    router.get(`/${path}/:id`, async (req, res) => {
      const actor = actorOf(res);
      if (['taxes', 'discounts'].includes(path)) permit(actor, `${path}:read`);
      const scope: Record<string, unknown> = { _id: objectId(req.params.id) };
      if (actor.role === 'customer') {
        if (path === 'quotation-templates') scope.active = true;
        else scope.status = 'active';
        if (path === 'plans')
          scope.$and = [
            {
              $or: [{ availableFrom: { $exists: false } }, { availableFrom: { $lte: new Date() } }],
            },
            {
              $or: [
                { availableUntil: { $exists: false } },
                { availableUntil: { $gt: new Date() } },
              ],
            },
          ];
      }
      const row = await collection
        .findOne(scope, actor.role !== 'admin' ? '-costPriceMinor -notes' : undefined)
        .lean();
      ensure(row, 404, 'NOT_FOUND', 'Record not found');
      res.json({ data: row });
    });
    router.post(`/${path}`, async (req, res) => {
      const actor = actorOf(res);
      ensure(actor.role === 'admin', 403, 'FORBIDDEN', 'Administrator access required');
      const data = schema.parse(req.body);
      await validateLinks(data);
      const row = await collection.create(data);
      await audit(actor, 'created', path, (row as { _id: unknown })._id, data);
      res.status(201).json({ data: row });
    });
    router.patch(`/${path}/:id`, async (req, res) => {
      const actor = actorOf(res);
      ensure(actor.role === 'admin', 403, 'FORBIDDEN', 'Administrator access required');
      const data = schema.parse(req.body);
      await validateLinks(data);
      const version = z.coerce.number().int().min(0).parse(req.get('If-Match'));
      const previous = await collection
        .findOne({ _id: objectId(req.params.id), __v: version })
        .lean();
      const optionalFields =
        path === 'plans'
          ? ['availableFrom', 'availableUntil']
          : path === 'taxes'
            ? ['effectiveUntil']
            : path === 'discounts'
              ? ['maxRedemptions']
              : [];
      const unset = Object.fromEntries(
        optionalFields.filter((name) => !(name in data)).map((name) => [name, '']),
      );
      const updateData: Record<string, unknown> = { ...data };
      for (const name of ['status', 'active'])
        if (previous && Object.hasOwn(previous, name) && !Object.hasOwn(req.body, name))
          updateData[name] = (previous as Record<string, unknown>)[name];
      const row = await collection.findOneAndUpdate(
        { _id: objectId(req.params.id), __v: version },
        {
          $set: updateData,
          $inc: { __v: 1 },
          ...(Object.keys(unset).length ? { $unset: unset } : {}),
        },
        { returnDocument: 'after', runValidators: true },
      );
      ensure(row, 409, 'VERSION_CONFLICT', 'Record changed; reload before saving');
      await audit(
        actor,
        'updated',
        path,
        (row as { _id: unknown })._id,
        updateData,
        undefined,
        previous,
      );
      res.json({ data: row });
    });
    router.delete(`/${path}/:id`, async (req, res) => {
      const actor = actorOf(res);
      ensure(actor.role === 'admin', 403, 'FORBIDDEN', 'Administrator access required');
      const update =
        path === 'taxes' || path === 'discounts' || path === 'quotation-templates'
          ? { active: false }
          : { status: 'archived' };
      const row = await collection.findByIdAndUpdate(
        objectId(req.params.id),
        { $set: update, $inc: { __v: 1 } },
        { returnDocument: 'after' },
      );
      ensure(row, 404, 'NOT_FOUND', 'Record not found');
      await audit(actor, 'archived', path, (row as { _id: unknown })._id);
      res.status(204).end();
    });
  }
  router.get('/products/:id/variants', async (req, res) => {
    const actor = actorOf(res);
    const product = await Product.findOne({
      _id: objectId(req.params.id),
      ...(actor.role === 'customer' ? { status: 'active' } : {}),
    });
    ensure(product, 404, 'NOT_FOUND', 'Product not found');
    res.json({
      data: await ProductVariant.find({
        productId: product._id,
        ...(actor.role === 'customer' ? { status: 'active' } : {}),
      }),
    });
  });
  for (const action of ['activate', 'deactivate'] as const)
    router.post(`/plans/:id/${action}`, async (req, res) => {
      ensure(actorOf(res).role === 'admin', 403, 'FORBIDDEN', 'Administrator access required');
      z.object({})
        .strict()
        .parse(req.body ?? {});
      const row = await Plan.findOneAndUpdate(
        { _id: objectId(req.params.id), status: { $ne: 'archived' } },
        { status: action === 'activate' ? 'active' : 'inactive', $inc: { __v: 1 } },
        { returnDocument: 'after' },
      );
      ensure(row, 404, 'NOT_FOUND', 'Plan not found');
      await audit(actorOf(res), action, 'Plan', row._id);
      res.json({ data: row });
    });
  router.post('/products/:id/variants', async (req, res) => {
    ensure(actorOf(res).role === 'admin', 403, 'FORBIDDEN', 'Administrator access required');
    ensure(
      await Product.exists({ _id: objectId(req.params.id), status: 'active' }),
      404,
      'NOT_FOUND',
      'Product not found',
    );
    const row = await ProductVariant.create({
      ...schemas.variantInput.parse(req.body),
      productId: req.params.id,
    });
    await audit(actorOf(res), 'created', 'ProductVariant', row._id);
    res.status(201).json({ data: row });
  });
  router.patch('/products/:id/variants/:variantId', async (req, res) => {
    ensure(actorOf(res).role === 'admin', 403, 'FORBIDDEN', 'Administrator access required');
    const row = await ProductVariant.findOneAndUpdate(
      { _id: objectId(req.params.variantId), productId: objectId(req.params.id) },
      schemas.variantInput.parse(req.body),
      { returnDocument: 'after', runValidators: true },
    );
    ensure(row, 404, 'NOT_FOUND', 'Variant not found');
    await audit(actorOf(res), 'updated', 'ProductVariant', row._id);
    res.json({ data: row });
  });
  router.delete('/products/:id/variants/:variantId', async (req, res) => {
    ensure(actorOf(res).role === 'admin', 403, 'FORBIDDEN', 'Administrator access required');
    const row = await ProductVariant.findOneAndUpdate(
      { _id: objectId(req.params.variantId), productId: objectId(req.params.id) },
      { status: 'archived' },
      { returnDocument: 'after' },
    );
    ensure(row, 404, 'NOT_FOUND', 'Variant not found');
    await audit(actorOf(res), 'archived', 'ProductVariant', row._id);
    res.status(204).end();
  });
  router.get('/customers', async (req, res) => {
    const actor = actorOf(res);
    if (actor.role === 'staff') permit(actor, 'customers:read');
    const query = listQuery.parse(req.query);
    const scope = {
      ...(await customerScope(actor)),
      ...(query.q ? { name: { $regex: escapeRegex(query.q), $options: 'i' } } : {}),
    };
    res.json({
      data: await Customer.find(scope)
        .sort(query.sort)
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize),
      meta: {
        total: await Customer.countDocuments(scope),
        page: query.page,
        pageSize: query.pageSize,
      },
    });
  });
  router.post('/customers', async (req, res) => {
    const actor = actorOf(res);
    permit(actor, 'customers:write');
    const data = schemas.customerInput.parse(req.body);
    if (actor.role === 'staff') data.assignedStaffIds = [actor.id];
    const row = await Customer.create(data);
    await audit(actor, 'created', 'Customer', row._id);
    res.status(201).json({ data: row });
  });
  router.get('/customers/:id', async (req, res) => {
    const row = await Customer.findOne({
      _id: objectId(req.params.id),
      ...(await customerScope(actorOf(res))),
    });
    ensure(row, 404, 'NOT_FOUND', 'Customer not found');
    res.json({ data: row });
  });
  router.patch('/customers/:id', async (req, res) => {
    const actor = actorOf(res);
    if (actor.role === 'staff') permit(actor, 'customers:write');
    const data = schemas.customerInput.omit({ assignedStaffIds: true }).parse(req.body);
    const row = await Customer.findOneAndUpdate(
      { _id: objectId(req.params.id), ...(await customerScope(actor)) },
      { $set: data, $inc: { __v: 1 } },
      { returnDocument: 'after' },
    );
    ensure(row, 404, 'NOT_FOUND', 'Customer not found');
    await audit(actor, 'updated', 'Customer', row._id, data);
    res.json({ data: row });
  });
  router.patch('/customers/:id/assignments', async (req, res) => {
    ensure(actorOf(res).role === 'admin', 403, 'FORBIDDEN', 'Administrator access required');
    const { assignedStaffIds } = z
      .object({ assignedStaffIds: z.array(schemas.id) })
      .strict()
      .parse(req.body);
    ensure(
      (await User.countDocuments({
        _id: { $in: assignedStaffIds },
        role: 'staff',
        active: true,
      })) === new Set(assignedStaffIds).size,
      422,
      'INVALID_STAFF',
      'Choose active staff',
    );
    const row = await Customer.findByIdAndUpdate(
      objectId(req.params.id),
      { assignedStaffIds },
      { returnDocument: 'after' },
    );
    ensure(row, 404, 'NOT_FOUND', 'Customer not found');
    await audit(actorOf(res), 'assigned', 'Customer', row._id, { assignedStaffIds });
    res.json({ data: row });
  });
  const staffSchema = z
    .object({
      name: z.string().min(2).max(100),
      email: emailSchema,
      password: passwordSchema,
      permissions: z
        .array(
          z.enum([
            'customers:read',
            'customers:write',
            'quotations:write',
            'subscriptions:write',
            'invoices:write',
            'payments:write',
            'reports:read',
            'taxes:read',
            'discounts:read',
          ]),
        )
        .default([]),
    })
    .strict();
  router.get('/staff', async (_req, res) => {
    ensure(actorOf(res).role === 'admin', 403, 'FORBIDDEN', 'Administrator access required');
    res.json({ data: await User.find({ role: 'staff' }).select('-passwordHash').limit(100) });
  });
  router.post('/staff', async (req, res) => {
    ensure(actorOf(res).role === 'admin', 403, 'FORBIDDEN', 'Administrator access required');
    const { password, ...data } = staffSchema.parse(req.body);
    const row = await User.create({
      ...data,
      role: 'staff',
      verifiedAt: new Date(),
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
    });
    await audit(actorOf(res), 'created', 'User', row._id, {
      role: 'staff',
      permissions: data.permissions,
    });
    res.status(201).json({ data: publicUser(row) });
  });
  router.patch('/staff/:id', async (req, res) => {
    ensure(actorOf(res).role === 'admin', 403, 'FORBIDDEN', 'Administrator access required');
    const data = staffSchema
      .omit({ password: true, email: true })
      .extend({ active: z.boolean() })
      .parse(req.body);
    const row = await User.findOneAndUpdate({ _id: objectId(req.params.id), role: 'staff' }, data, {
      returnDocument: 'after',
    });
    ensure(row, 404, 'NOT_FOUND', 'Staff not found');
    await audit(actorOf(res), 'permissions_changed', 'User', row._id, data);
    res.json({ data: publicUser(row) });
  });
  router.get('/me', async (_req, res) => {
    const actor = actorOf(res);
    res.json({ data: { ...actor, customer: await Customer.findOne({ userId: actor.id }) } });
  });
  router.patch('/me', async (req, res) => {
    const actor = actorOf(res);
    const data = z
      .object({
        name: z.string().min(2).max(100),
        company: z.string().max(150).optional(),
        phone: z.string().max(40).optional(),
        address: z.string().max(2000).optional(),
        taxId: z.string().max(100).optional(),
      })
      .strict()
      .parse(req.body);
    await User.updateOne({ _id: actor.id }, { name: data.name });
    await Customer.updateOne({ userId: actor.id }, data);
    res.json({ data: { message: 'Profile updated' } });
  });
  for (const [path, model] of [
    ['audit-logs', AuditLog],
    ['notifications', Notification],
    ['billing-records', BillingRecord],
  ] as const)
    router.get(`/${path}`, async (req, res) => {
      ensure(actorOf(res).role === 'admin', 403, 'FORBIDDEN', 'Administrator access required');
      const query = listQuery.parse(req.query);
      const scope = query.status ? { status: query.status } : {};
      res.json({
        data: await (model as Model<unknown>)
          .find(scope)
          .select(path === 'notifications' ? '-text' : '')
          .sort('-createdAt')
          .skip((query.page - 1) * query.pageSize)
          .limit(query.pageSize),
        meta: {
          total: await (model as Model<unknown>).countDocuments(scope),
          page: query.page,
          pageSize: query.pageSize,
        },
      });
    });
  router.get('/settings', async (_req, res) => {
    ensure(actorOf(res).role === 'admin', 403, 'FORBIDDEN', 'Administrator access required');
    res.json({ data: await SystemSetting.find().lean() });
  });
  router.patch('/settings', async (req, res) => {
    const actor = actorOf(res);
    ensure(actor.role === 'admin', 403, 'FORBIDDEN', 'Administrator access required');
    const data = z
      .object({
        companyName: z.string().min(2).max(150),
        defaultTermsDays: z.number().int().min(0).max(365),
        invoiceFooter: z.string().max(2000).default(''),
      })
      .strict()
      .parse(req.body);
    await SystemSetting.updateOne({ key: 'business' }, { $set: { value: data } }, { upsert: true });
    await audit(actor, 'updated', 'SystemSetting', 'business', data);
    res.json({ data });
  });
  return router;
}

import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import PDFDocument from 'pdfkit';
import { outstanding, roundRatio } from '@subscriptiq/domain';
import {
  Invoice,
  Subscription,
  PaymentAllocation,
  CreditNote,
  Command,
  Customer,
} from '../../models/index.js';
import { authenticate, type AuthConfig, hashToken } from '../auth/service.js';
import { actorOf, listQuery, escapeRegex } from '../catalog/routes.js';
import {
  resourceScope,
  objectId,
  permit,
  audit,
  notify,
  numberFor,
} from '../../services/context.js';
import { ensure } from '../../lib/errors.js';
import { billCycle } from '../billing/service.js';
import { previewInvoice, cancelInvoice } from './service.js';
const format = (minor: number) => `INR ${(minor / 100).toFixed(2)}`;
export function invoiceRoutes(config: AuthConfig) {
  const router = Router();
  router.use(async (req, res, next) => {
    res.locals.actor ??= await authenticate(req.get('authorization'), config);
    if (
      actorOf(res).role === 'staff' &&
      (req.path.startsWith('/invoices') || req.path.endsWith('/invoices'))
    )
      permit(actorOf(res), 'invoices:write');
    next();
  });
  router.get('/invoices', async (req, res) => {
    const query = listQuery.parse(req.query);
    const actor = actorOf(res);
    if (actor.role === 'staff') permit(actor, 'invoices:write');
    const scope: Record<string, unknown> = {
      ...(await resourceScope(actor)),
      ...(query.q ? { number: { $regex: escapeRegex(query.q), $options: 'i' } } : {}),
    };
    if (query.status === 'overdue')
      Object.assign(scope, {
        status: 'confirmed',
        dueAt: { $lt: new Date() },
        $expr: {
          $gt: [{ $subtract: ['$totalMinor', { $add: ['$paidMinor', '$creditedMinor'] }] }, 0],
        },
      });
    else if (query.status) scope.status = query.status;
    const rows = await Invoice.find(scope)
      .sort(query.sort)
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize)
      .lean();
    res.json({
      data: rows.map((row) => ({
        ...row,
        outstandingMinor: row.status === 'confirmed' ? outstanding(row) : 0,
        paymentStatus:
          row.status !== 'confirmed'
            ? row.status
            : outstanding(row) === 0
              ? 'paid'
              : row.paidMinor > 0
                ? 'partial'
                : row.dueAt < new Date()
                  ? 'overdue'
                  : 'unpaid',
      })),
      meta: {
        total: await Invoice.countDocuments(scope),
        page: query.page,
        pageSize: query.pageSize,
      },
    });
  });
  router.get('/invoices/:id', async (req, res) => {
    const invoice = await Invoice.findOne({
      _id: objectId(req.params.id),
      ...(await resourceScope(actorOf(res))),
    }).lean();
    ensure(invoice, 404, 'NOT_FOUND', 'Invoice not found');
    res.json({ data: { ...invoice, outstandingMinor: outstanding(invoice) } });
  });
  router.post('/subscriptions/:id/invoices', async (req, res) => {
    permit(actorOf(res), 'invoices:write');
    const body = z
      .object({ draft: z.boolean().default(false) })
      .strict()
      .parse(req.body ?? {});
    const sub = await Subscription.findOne({
      _id: objectId(req.params.id),
      ...(await resourceScope(actorOf(res))),
    });
    ensure(sub, 404, 'NOT_FOUND', 'Subscription not found');
    const invoiceId = body.draft
      ? (await previewInvoice(actorOf(res), String(sub._id)))._id
      : await billCycle(String(sub._id), sub.nextBillingAt);
    res.status(201).json({ data: { invoiceId } });
  });
  router.post('/invoices/:id/confirm', async (req, res) => {
    permit(actorOf(res), 'invoices:write');
    const invoice = await Invoice.findOne({
      _id: objectId(req.params.id),
      ...(await resourceScope(actorOf(res))),
      status: 'draft',
    });
    ensure(invoice, 409, 'INVALID_STATE', 'Only draft invoices can be confirmed');
    ensure(invoice.cycleStart, 409, 'INVALID_DRAFT', 'Draft does not reference a billable cycle');
    await billCycle(String(invoice.subscriptionId), invoice.cycleStart);
    await audit(actorOf(res), 'confirmed', 'Invoice', invoice._id);
    res.json({ data: await Invoice.findById(invoice._id) });
  });
  router.post('/invoices/:id/cancel', async (req, res) => {
    const { reason } = z
      .object({ reason: z.string().min(3).max(2000) })
      .strict()
      .parse(req.body);
    res.json({ data: await cancelInvoice(actorOf(res), objectId(req.params.id), reason) });
  });
  router.post('/invoices/:id/send', async (req, res) => {
    permit(actorOf(res), 'invoices:write');
    const row = await Invoice.findOne({
      _id: objectId(req.params.id),
      ...(await resourceScope(actorOf(res))),
      status: 'confirmed',
    });
    ensure(row, 404, 'NOT_FOUND', 'Invoice not found');
    await notify(
      row.customerSnapshot!.email!,
      `Invoice ${row.number}`,
      `Please sign in to view invoice ${row.number}, total ${format(row.totalMinor)}.`,
      `resend-${row._id}-${z.string().min(8).max(100).parse(req.get('Idempotency-Key'))}`,
    );
    res.json({ data: { message: 'Invoice email queued' } });
  });
  router.get('/invoices/:id/history', async (req, res) => {
    const row = await Invoice.findOne({
      _id: objectId(req.params.id),
      ...(await resourceScope(actorOf(res))),
    });
    ensure(row, 404, 'NOT_FOUND', 'Invoice not found');
    res.json({
      data: {
        allocations: await PaymentAllocation.find({ invoiceId: row._id }),
        credits: await CreditNote.find({ invoiceId: row._id }),
      },
    });
  });
  router.post('/invoices/:id/credit-notes', async (req, res) => {
    const actor = actorOf(res);
    ensure(actor.role === 'admin', 403, 'FORBIDDEN', 'Administrator access required');
    const body = z
      .object({
        amountMinor: z.number().int().positive().max(1_000_000_000),
        reason: z.string().min(3).max(2000),
      })
      .strict()
      .parse(req.body);
    const key = `credit-${actor.id}-${z.string().min(8).max(100).parse(req.get('Idempotency-Key'))}`;
    const payloadHash = hashToken(JSON.stringify({ invoiceId: req.params.id, ...body }));
    const result = await mongoose.connection.transaction(async (session) => {
      const previous = await Command.findOne({ key }).session(session);
      if (previous) {
        ensure(
          previous.hash === payloadHash,
          409,
          'KEY_REUSED',
          'Idempotency key used for another request',
        );
        return CreditNote.findById(previous.resultId).session(session);
      }
      const invoice = await Invoice.findOne({
        _id: objectId(req.params.id),
        status: 'confirmed',
      }).session(session);
      ensure(
        invoice && body.amountMinor <= outstanding(invoice),
        409,
        'INVALID_CREDIT',
        'Credit cannot exceed outstanding balance',
      );
      const taxMinor =
        roundRatio(invoice.creditedMinor + body.amountMinor, invoice.taxMinor, invoice.totalMinor) -
        invoice.creditedTaxMinor;
      const preTaxMinor = body.amountMinor - taxMinor;
      const [credit] = await CreditNote.create(
        [
          {
            ...body,
            preTaxMinor,
            taxMinor,
            number: await numberFor('CRN', session),
            invoiceId: invoice._id,
            actorId: actor.id,
            requestKey: key,
          },
        ],
        { session },
      );
      invoice.creditedMinor += body.amountMinor;
      invoice.creditedPreTaxMinor += preTaxMinor;
      invoice.creditedTaxMinor += taxMinor;
      await invoice.save({ session });
      await Command.create(
        [{ key, hash: payloadHash, type: 'credit', resultId: String(credit!._id) }],
        { session },
      );
      await audit(
        actor,
        'credited',
        'Invoice',
        invoice._id,
        { creditId: credit!._id, ...body },
        session,
      );
      return credit;
    });
    res.status(201).json({ data: result });
  });
  router.get('/invoices/:id/pdf', async (req, res) => {
    const invoice = await Invoice.findOne({
      _id: objectId(req.params.id),
      ...(await resourceScope(actorOf(res))),
    });
    ensure(invoice, 404, 'NOT_FOUND', 'Invoice not found');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${invoice.number}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    const pdf = new PDFDocument({
      size: 'A4',
      margin: 48,
      info: { Title: `Invoice ${invoice.number}`, Author: 'Brightloop Software' },
    });
    pdf.pipe(res);
    pdf.fontSize(24).fillColor('#4f46e5').text('SubscriptIQ');
    pdf
      .fontSize(10)
      .fillColor('#64748b')
      .text(invoice.companySnapshot?.name ?? 'Brightloop Software');
    pdf.moveDown(2);
    pdf
      .fontSize(22)
      .fillColor('#0f172a')
      .text(
        invoice.status === 'draft'
          ? 'DRAFT INVOICE'
          : invoice.status === 'cancelled'
            ? 'CANCELLED INVOICE'
            : 'INVOICE',
      );
    if (invoice.status === 'draft')
      pdf.fontSize(9).text('Preview only. Totals are recalculated at finalization. Not payable.');
    pdf.fontSize(11).text(invoice.number);
    pdf.text(
      `Issued: ${invoice.issuedAt.toISOString().slice(0, 10)}     Due: ${invoice.dueAt.toISOString().slice(0, 10)}`,
    );
    pdf.moveDown();
    pdf
      .fontSize(10)
      .text(`Bill to: ${invoice.customerSnapshot?.name ?? ''}`)
      .text(invoice.customerSnapshot?.company ?? '')
      .text(invoice.customerSnapshot?.email ?? '')
      .text(invoice.customerSnapshot?.address ?? '')
      .text(invoice.customerSnapshot?.taxId ?? '');
    pdf.moveDown();
    for (const line of invoice.lines) {
      if (pdf.y > 650) pdf.addPage();
      pdf.fillColor('#0f172a').fontSize(11).text(line.name);
      pdf
        .fillColor('#64748b')
        .fontSize(9)
        .text(
          `${line.quantity} x ${format(line.unitPriceMinor)}     Discount ${format(line.discountMinor)}     Tax ${format(line.taxMinor)}`,
        );
      pdf.fillColor('#0f172a').text(format(line.totalMinor), { align: 'right' });
      for (const tax of line.taxes)
        pdf
          .fillColor('#64748b')
          .text(`${tax.name}: ${tax.rateBps! / 100}% — ${format(tax.amountMinor)}`, {
            align: 'right',
          });
      pdf.moveDown();
    }
    if (pdf.y > 620) pdf.addPage();
    pdf
      .moveDown()
      .fontSize(10)
      .fillColor('#475569')
      .text(`Subtotal: ${format(invoice.subtotalMinor)}`, { align: 'right' })
      .text(`Discount: ${format(invoice.discountMinor)}`, { align: 'right' })
      .text(`Tax: ${format(invoice.taxMinor)}`, { align: 'right' })
      .fontSize(16)
      .fillColor('#4f46e5')
      .text(`Total: ${format(invoice.totalMinor)}`, { align: 'right' })
      .fontSize(10)
      .fillColor('#475569')
      .text(`Paid: ${format(invoice.paidMinor)}   Credited: ${format(invoice.creditedMinor)}`, {
        align: 'right',
      })
      .text(`Outstanding: ${format(outstanding(invoice))}`, { align: 'right' });
    pdf
      .moveDown(3)
      .fontSize(9)
      .text(
        invoice.companySnapshot?.footer ||
          'Thank you for choosing Brightloop Software. Historical pricing and tax details are preserved on this invoice.',
      );
    pdf.end();
  });
  return router;
}

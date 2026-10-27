import { Router } from 'express';
import { Types } from 'mongoose';
import { optionalChargePointRef, requireChargePointRef } from '../../lib/chargePointRef';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env';
import { notFound } from '../../lib/errors';
import { PAYMENT_PROVIDERS, PAYMENT_PURPOSES, PAYMENT_STATUSES, Payment } from '../../models/Payment';
import { ChargePoint } from '../../models/ChargePoint';
import { Transaction } from '../../models/Transaction';
import { store } from '../../driver/store';
import { normalizePhone } from '../../driver/validation';
import {
  cancelPayment,
  createPayment,
  handleCallback,
  reconcilePendingPayments,
  refundPayment,
  syncPayment,
  toPaymentView,
} from '../../services/payment.service';
import { tokenStatus } from '../../services/qpay/tokens';
import {
  asyncHandler,
  paginate,
  paginationSchema,
  requireAuth,
  requireAdmin,
  requireOperator,
  validate,
} from '../middleware';

export const paymentsRouter = Router();

// ---------------------------------------------------------------------------
// QPay callback — unauthenticated by design (QPay cannot send our JWT), guarded
// by a per-invoice secret in the path and rate limited. The handler never trusts
// the request body: it re-checks the payment against QPay before changing state.
// ---------------------------------------------------------------------------

const callbackLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

const callbackHandler = asyncHandler(async (req, res) => {
  const { paymentId, secret, token } = req.params as {
    paymentId: string;
    secret: string;
    token?: string;
  };
  const payment = await handleCallback(paymentId, secret, token);
  // QPay only checks for a 2xx; keep the body minimal.
  res.json({ status: payment.status, paidAmount: payment.paidAmount });
});

// With QPAY_CALLBACK_TOKEN set the URL carries it as the first path segment.
paymentsRouter.all('/callback/:token/:paymentId/:secret', callbackLimiter, callbackHandler);
paymentsRouter.all('/callback/:paymentId/:secret', callbackLimiter, callbackHandler);

// ---------------------------------------------------------------------------
// Everything below requires an authenticated principal.
// ---------------------------------------------------------------------------

paymentsRouter.use(requireAuth);

paymentsRouter.get(
  '/config',
  asyncHandler(async (_req, res) => {
    res.json({
      enabled: env.QPAY_ENABLED,
      mode: env.QPAY_MODE,
      quickQrEnabled: env.QPAY_QUICKQR_ENABLED,
      invoiceTtlMinutes: env.QPAY_INVOICE_TTL_MINUTES,
      credentialsConfigured: !!(env.QPAY_USERNAME && env.QPAY_PASSWORD),
      tokens: [tokenStatus('merchant'), tokenStatus('quickqr')],
    });
  }),
);

const createSchema = z.object({
  amount: z.number().positive().optional(),
  description: z.string().min(1).max(255).optional(),
  senderInvoiceNo: z.string().min(1).max(45).optional(),
  receiverCode: z.string().min(1).max(45).optional(),
  receiver: z
    .object({
      register: z.string().optional(),
      name: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
    })
    .optional(),
  transactionId: z.number().int().optional(),
  chargePointId: z.string().optional(),
  connectorId: z.number().int().optional(),
  idTag: z.string().optional(),
  userId: z.string().optional(),
  quickQrMerchantId: z.string().optional(),
  bankAccounts: z
    .array(
      z.object({
        account_bank_code: z.string(),
        account_number: z.string(),
        account_name: z.string(),
        is_default: z.boolean().optional(),
      }),
    )
    .optional(),
  lines: z
    .array(
      z.object({
        line_description: z.string(),
        line_quantity: z.string(),
        line_unit_price: z.string(),
        tax_product_code: z.string().optional(),
        note: z.string().optional(),
      }),
    )
    .optional(),
  expiryMinutes: z.number().int().min(1).max(1440).optional(),
});

/** Create an invoice; returns the QR payload the client renders. */
paymentsRouter.post(
  '/',
  requireOperator,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof createSchema>;
    const payment = await createPayment({
      ...input,
      chargePointId: await optionalChargePointRef(input.chargePointId),
    });
    res.status(201).json(toPaymentView(payment));
  }),
);

/** Convenience wrapper: invoice the cost of one charging session. */
paymentsRouter.post(
  '/transactions/:transactionId',
  requireOperator,
  validate(createSchema.omit({ transactionId: true })),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof createSchema>;
    const payment = await createPayment({
      ...input,
      chargePointId: await optionalChargePointRef(input.chargePointId),
      transactionId: Number(req.params.transactionId),
    });
    res.status(201).json(toPaymentView(payment));
  }),
);

const listQuery = paginationSchema.extend({
  status: z.enum(PAYMENT_STATUSES).optional(),
  provider: z.enum(PAYMENT_PROVIDERS).optional(),
  purpose: z.enum(PAYMENT_PURPOSES).optional(),
  /** Driver phone, our transaction id or the provider's invoice id. */
  q: z.string().trim().max(64).optional(),
  chargePointId: z.string().optional(),
  idTag: z.string().optional(),
  transactionId: z.coerce.number().int().optional(),
  senderInvoiceNo: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

paymentsRouter.get(
  '/',
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const filter: Record<string, unknown> = {};

    if ((req.user?.role === 'CLIENT' || req.user?.clientId) && req.user.clientId) {
      const clientOid = new Types.ObjectId(req.user.clientId);
      const clientStations = await ChargePoint.find({
        $or: [{ clientId: clientOid }, { linkedClientIds: clientOid }],
      }).select('_id').lean();
      const stationIds = clientStations.map((s) => s._id);
      const clientTxIds = await Transaction.distinct('_id', { clientId: clientOid });
      filter.$or = [
        { chargePointId: { $in: stationIds } },
        { transactionId: { $in: clientTxIds } },
      ];
    }
    if (q.status) filter.status = q.status;
    if (q.provider) filter.provider = q.provider;
    if (q.purpose) filter.purpose = q.purpose;
    if (q.q) {
      // One box for what support is usually handed: a phone number, or the
      // id on the driver's receipt / bank page.
      const term = q.q;
      const or: Record<string, unknown>[] = [{ senderInvoiceNo: term }, { invoiceId: term }];
      const phone = normalizePhone(term);
      const driver = phone ? await store.findUserByPhone(phone).catch(() => null) : null;
      if (driver) or.push({ userId: driver.id }, { walletOwnerId: driver.id });
      filter.$or = or;
    }
    if (q.chargePointId) filter.chargePointId = await requireChargePointRef(q.chargePointId);
    if (q.idTag) filter.idTag = q.idTag;
    if (q.transactionId !== undefined) filter.transactionId = q.transactionId;
    if (q.senderInvoiceNo) filter.senderInvoiceNo = q.senderInvoiceNo;
    if (q.from || q.to) {
      filter.createdAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
    }

    const { skip, limit } = paginate(q);
    const summaryFilter = { ...filter };
    delete summaryFilter.status;
    const [data, total, totals] = await Promise.all([
      Payment.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Payment.countDocuments(filter),
      Payment.aggregate<{ _id: string; count: number; amount: number }>([
        { $match: summaryFilter },
        { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$paidAmount' } } },
      ]),
    ]);

    // Who paid, so support can match a call to a row without another lookup.
    const drivers = await store
      .findUsersByIds(data.map((p) => p.userId ?? p.walletOwnerId ?? '').filter(Boolean))
      .catch(() => new Map<string, never>());

    res.json({
      data: data.map((p) => {
        const driver = drivers.get(p.userId ?? p.walletOwnerId ?? '');
        return {
          ...toPaymentView(p),
          driver: driver ? { name: driver.name, phone: driver.phone } : null,
        };
      }),
      total,
      page: q.page,
      limit: q.limit,
      summary: Object.fromEntries(totals.map((t) => [t._id, { count: t.count, amount: t.amount }])),
    });
  }),
);

const findOr404 = async (id: string) => {
  const payment = await Payment.findById(id).select('+callbackSecret');
  if (!payment) throw notFound('Payment not found');
  return payment;
};

paymentsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const payment = await Payment.findById(req.params.id).lean();
    if (!payment) throw notFound('Payment not found');
    res.json(toPaymentView(payment));
  }),
);

/** The base64 QR image, kept out of the normal payload because of its size. */
paymentsRouter.get(
  '/:id/qr',
  asyncHandler(async (req, res) => {
    const payment = await Payment.findById(req.params.id).select('+qrImage').lean();
    if (!payment) throw notFound('Payment not found');
    res.json({
      id: String(payment._id),
      status: payment.status,
      qrText: payment.qrText,
      qrImage: payment.qrImage,
      shortUrl: payment.shortUrl,
      deeplinks: payment.deeplinks,
    });
  }),
);

/** Ask QPay for the current state of this invoice (client polling entry point). */
paymentsRouter.post(
  '/:id/check',
  asyncHandler(async (req, res) => {
    const payment = await syncPayment(await findOr404(req.params.id));
    res.json(toPaymentView(payment));
  }),
);

paymentsRouter.post(
  '/:id/cancel',
  requireOperator,
  asyncHandler(async (req, res) => {
    const payment = await cancelPayment(await findOr404(req.params.id));
    res.json(toPaymentView(payment));
  }),
);

paymentsRouter.post(
  '/:id/refund',
  requireAdmin,
  validate(z.object({ note: z.string().max(255).optional() })),
  asyncHandler(async (req, res) => {
    const payment = await refundPayment(
      await findOr404(req.params.id),
      (req.body as { note?: string }).note,
    );
    res.json(toPaymentView(payment));
  }),
);

/** Sweep pending invoices — the fallback for callbacks QPay never delivered. */
paymentsRouter.post(
  '/reconcile',
  requireAdmin,
  validate(z.object({ limit: z.number().int().min(1).max(500).optional() })),
  asyncHandler(async (req, res) => {
    res.json(await reconcilePendingPayments((req.body as { limit?: number }).limit ?? 50));
  }),
);

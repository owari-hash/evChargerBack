import { Router } from 'express';
import { z } from 'zod';
import { requireChargePoint, requireChargePointRef } from '../../lib/chargePointRef';
import { notFound } from '../../lib/errors';
import { MeterValue } from '../../models/MeterValue';
import { Transaction } from '../../models/Transaction';
import { TRANSACTION_STATUSES } from '../../models/enums';
import { connectionManager } from '../../ocpp/manager';
import { stopTransaction } from '../../services/transaction.service';
import {
  asyncHandler,
  paginate,
  paginationSchema,
  requireAuth,
  requireOperator,
  validate,
} from '../middleware';

export const transactionsRouter = Router();
transactionsRouter.use(requireAuth);

const listQuery = paginationSchema.extend({
  chargePointId: z.string().optional(),
  connectorId: z.coerce.number().int().optional(),
  idTag: z.string().optional(),
  status: z.enum(TRANSACTION_STATUSES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

transactionsRouter.get(
  '/',
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const filter: Record<string, unknown> = {};
    if (q.chargePointId) filter.chargePointId = await requireChargePointRef(q.chargePointId);
    if (q.connectorId !== undefined) filter.connectorId = q.connectorId;
    if (q.idTag) filter.idTag = q.idTag;
    if (q.status) filter.status = q.status;
    if (q.from || q.to) {
      filter.startTimestamp = {
        ...(q.from ? { $gte: q.from } : {}),
        ...(q.to ? { $lte: q.to } : {}),
      };
    }

    const { skip, limit } = paginate(q);
    const [data, total] = await Promise.all([
      Transaction.find(filter).sort({ startTimestamp: -1 }).skip(skip).limit(limit).lean(),
      Transaction.countDocuments(filter),
    ]);

    res.json({
      data: data.map((t) => ({ ...t, transactionId: t._id, id: t._id })),
      total,
      page: q.page,
      limit: q.limit,
    });
  }),
);

transactionsRouter.get(
  '/active',
  asyncHandler(async (_req, res) => {
    const data = await Transaction.find({ status: 'Active' }).sort({ startTimestamp: -1 }).lean();
    res.json(data.map((t) => ({ ...t, transactionId: t._id, id: t._id })));
  }),
);

transactionsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const tx = await Transaction.findById(Number(req.params.id)).lean();
    if (!tx) throw notFound('Transaction not found');
    res.json({ ...tx, transactionId: tx._id, id: tx._id });
  }),
);

const mvQuery = paginationSchema.extend({ measurand: z.string().optional() });

transactionsRouter.get(
  '/:id/meter-values',
  validate(mvQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof mvQuery>;
    const filter: Record<string, unknown> = { transactionId: Number(req.params.id) };
    if (q.measurand) filter['sampledValue.measurand'] = q.measurand;

    const { skip, limit } = paginate(q);
    const [data, total] = await Promise.all([
      MeterValue.find(filter).sort({ timestamp: 1 }).skip(skip).limit(limit).lean(),
      MeterValue.countDocuments(filter),
    ]);
    res.json({ data, total, page: q.page, limit: q.limit });
  }),
);

/** Remotely stop an active transaction (convenience wrapper over RemoteStopTransaction). */
transactionsRouter.post(
  '/:id/stop',
  requireOperator,
  asyncHandler(async (req, res) => {
    const tx = await Transaction.findById(Number(req.params.id));
    if (!tx) throw notFound('Transaction not found');
    if (tx.status !== 'Active') {
      res.json({ status: 'AlreadyStopped', transaction: tx.toJSON() });
      return;
    }
    const cp = await requireChargePoint(String(tx.chargePointId));
    const result = await connectionManager.send<{ status: string }>(
      cp.cpId,
      'RemoteStopTransaction',
      { transactionId: tx._id },
      req.user?.email,
    );
    if (result.status === 'Accepted') {
      tx.stoppedRemotely = true;
      await tx.save();
    }
    res.json(result);
  }),
);

/**
 * Force-close a transaction in the database without talking to the charge point.
 * Use when a charge point will never send the StopTransaction (e.g. it was
 * decommissioned while charging).
 */
const forceCloseSchema = z.object({
  meterStop: z.number().int().optional(),
  reason: z.string().optional(),
});

transactionsRouter.post(
  '/:id/force-close',
  requireOperator,
  validate(forceCloseSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof forceCloseSchema>;
    const tx = await Transaction.findById(Number(req.params.id));
    if (!tx) throw notFound('Transaction not found');

    const cp = await requireChargePoint(String(tx.chargePointId));
    await stopTransaction({
      chargePointId: tx.chargePointId,
      cpId: cp.cpId,
      transactionId: tx._id,
      meterStop: body.meterStop ?? tx.lastMeterWh ?? tx.meterStart,
      timestamp: new Date(),
      reason: 'Other',
    });

    res.json((await Transaction.findById(tx._id))?.toJSON());
  }),
);

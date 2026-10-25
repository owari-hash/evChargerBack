import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { requireChargePoint, requireChargePointRef } from '../../lib/chargePointRef';
import { forbidden, notFound } from '../../lib/errors';
import { ChargePoint } from '../../models/ChargePoint';
import { MeterValue } from '../../models/MeterValue';
import { Transaction } from '../../models/Transaction';
import { TRANSACTION_STATUSES } from '../../models/enums';
import { connectionManager } from '../../ocpp/manager';
import { closeFromLastMeter } from '../../services/transaction.service';
import { refundTransaction } from '../../services/refund.service';
import { issueEBarimtForTransaction } from '../../services/ebarimt.service';
import { store } from '../../driver/store';
import {
  asyncHandler,
  paginate,
  paginationSchema,
  requireAdmin,
  requireAuth,
  requireOperator,
  validate,
} from '../middleware';

export const transactionsRouter = Router();
transactionsRouter.use(requireAuth);

/** What the console shows for who was actually charging — name/phone and the
 * one vehicle on their account, looked up from the bare `idTag` on the log. */
type DriverSummary = { name?: string; phone?: string; vehicleBrand?: string; vehicleModel?: string };

function toDriverSummary(user: {
  name?: string;
  phone?: string;
  vehicleBrand?: string;
  vehicleModel?: string;
}): DriverSummary {
  return {
    name: user.name,
    phone: user.phone,
    vehicleBrand: user.vehicleBrand,
    vehicleModel: user.vehicleModel,
  };
}

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
    if ((req.user?.role === 'CLIENT' || req.user?.clientId) && req.user.clientId) {
      filter.clientId = new Types.ObjectId(req.user.clientId);
    }
    if (q.chargePointId) filter.chargePointId = await requireChargePointRef(q.chargePointId);
    if (q.connectorId !== undefined) filter.connectorId = q.connectorId;
    if (q.idTag) filter.idTag = q.idTag;
    if (q.status) filter.status = q.status;
    if (q.from || q.to) {
      let fromDate = q.from;
      let toDate = q.to;
      if (
        toDate &&
        toDate.getUTCHours() === 0 &&
        toDate.getUTCMinutes() === 0 &&
        toDate.getUTCSeconds() === 0 &&
        toDate.getUTCMilliseconds() === 0
      ) {
        toDate = new Date(toDate.getTime() + 24 * 60 * 60 * 1000 - 1);
      }
      filter.startTimestamp = {
        ...(fromDate ? { $gte: fromDate } : {}),
        ...(toDate ? { $lte: toDate } : {}),
      };
    }

    const { skip, limit } = paginate(q);
    const [data, total] = await Promise.all([
      Transaction.find(filter).sort({ startTimestamp: -1 }).skip(skip).limit(limit).lean(),
      Transaction.countDocuments(filter),
    ]);

    const cpIds = [...new Set(data.map((t) => t.chargePointId).filter(Boolean))];
    const [driversByIdTag, chargePoints] = await Promise.all([
      store.findUsersByIdTags(data.map((t) => t.idTag)),
      cpIds.length > 0 ? ChargePoint.find({ _id: { $in: cpIds } }).select('_id cpId name').lean() : [],
    ]);
    const cpMap = new Map(chargePoints.map((cp) => [String(cp._id), cp]));

    res.json({
      data: data.map((t) => {
        const driver = driversByIdTag.get(t.idTag);
        const cp = cpMap.get(String(t.chargePointId));
        return {
          ...t,
          transactionId: t._id,
          id: t._id,
          driver: driver ? toDriverSummary(driver) : null,
          cpId: cp?.cpId,
          chargePointName: cp?.name || cp?.cpId,
          chargePoint: cp ? { id: String(cp._id), cpId: cp.cpId, name: cp.name } : null,
        };
      }),
      total,
      page: q.page,
      limit: q.limit,
    });
  }),
);

transactionsRouter.get(
  '/active',
  asyncHandler(async (req, res) => {
    const filter: Record<string, unknown> = { status: 'Active' };
    if ((req.user?.role === 'CLIENT' || req.user?.clientId) && req.user.clientId) {
      filter.clientId = new Types.ObjectId(req.user.clientId);
    }
    const data = await Transaction.find(filter).sort({ startTimestamp: -1 }).lean();
    const cpIds = [...new Set(data.map((t) => t.chargePointId).filter(Boolean))];
    const [driversByIdTag, chargePoints] = await Promise.all([
      store.findUsersByIdTags(data.map((t) => t.idTag)),
      cpIds.length > 0 ? ChargePoint.find({ _id: { $in: cpIds } }).select('_id cpId name').lean() : [],
    ]);
    const cpMap = new Map(chargePoints.map((cp) => [String(cp._id), cp]));

    res.json(
      data.map((t) => {
        const driver = driversByIdTag.get(t.idTag);
        const cp = cpMap.get(String(t.chargePointId));
        return {
          ...t,
          transactionId: t._id,
          id: t._id,
          driver: driver ? toDriverSummary(driver) : null,
          cpId: cp?.cpId,
          chargePointName: cp?.name || cp?.cpId,
          chargePoint: cp ? { id: String(cp._id), cpId: cp.cpId, name: cp.name } : null,
        };
      }),
    );
  }),
);

transactionsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const tx = await Transaction.findById(Number(req.params.id)).lean();
    if (!tx) throw notFound('Transaction not found');
    if ((req.user?.role === 'CLIENT' || req.user?.clientId) && req.user.clientId && String(tx.clientId ?? '') !== String(req.user.clientId)) {
      throw forbidden('Access denied');
    }
    const [driver, cp] = await Promise.all([
      store.findUserByIdTag(tx.idTag),
      ChargePoint.findById(tx.chargePointId).select('_id cpId name').lean(),
    ]);
    res.json({
      ...tx,
      transactionId: tx._id,
      id: tx._id,
      driver: driver ? toDriverSummary(driver) : null,
      cpId: cp?.cpId,
      chargePointName: cp?.name || cp?.cpId,
      chargePoint: cp ? { id: String(cp._id), cpId: cp.cpId, name: cp.name } : null,
    });
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
    // Closed from the last known meter; if the station still sends its own
    // StopTransaction later, the bill is corrected to the real reading.
    if (tx.status === 'Active') {
      await closeFromLastMeter(tx, cp.cpId, 'Other', body.meterStop ?? undefined);
    }

    res.json((await Transaction.findById(tx._id))?.toJSON());
  }),
);

const ebarimtSchema = z.object({
  type: z.enum(['B2C_RECEIPT', 'B2B_RECEIPT']).optional(),
  customerTin: z.string().optional(),
  customerNo: z.string().optional(),
});

transactionsRouter.post(
  '/:id/ebarimt',
  requireOperator,
  validate(ebarimtSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof ebarimtSchema>;
    const tx = await issueEBarimtForTransaction(Number(req.params.id), body);
    res.json(tx.toJSON());
  }),
);

/**
 * Буцаалт — refund a completed session to the driver's wallet and return its
 * e-barimt receipt. Admin only: it moves money.
 */
const refundSchema = z.object({
  reason: z.string().trim().min(1, 'Буцаалтын шалтгаан оруулна уу').max(255),
  accountNumber: z.string().trim().max(50).optional(),
});

transactionsRouter.post(
  '/:id/refund',
  requireAdmin,
  validate(refundSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof refundSchema>;
    const tx = await refundTransaction(Number(req.params.id), {
      reason: body.reason,
      accountNumber: body.accountNumber,
      refundedBy: req.user?.email ?? 'admin',
    });
    res.json(tx.toJSON());
  }),
);

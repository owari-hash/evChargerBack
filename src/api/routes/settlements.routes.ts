import { Router } from 'express';
import { isValidObjectId, Types } from 'mongoose';
import { z } from 'zod';
import { env } from '../../config/env';
import { badRequest, notFound } from '../../lib/errors';
import { Client } from '../../models/Client';
import { Settlement } from '../../models/Settlement';
import { Transaction } from '../../models/Transaction';
import { asyncHandler, requireAdmin, requireAuth, requireOperator, validate } from '../middleware';

/**
 * Тооцоо — what each client (Харилцагч) has earned and been paid.
 *
 * Drivers pay into Eplug's account. A completed session at a client's station
 * earns the client its cost minus Eplug's fee (`net`). Payouts are recorded as
 * Settlements; `outstanding` = everything earned − everything paid. A refund
 * (Буцаалт) takes the session out of the earnings, so it can go negative when
 * a session was refunded after being paid out.
 */
export const settlementsRouter = Router();
settlementsRouter.use(requireAuth, requireOperator);

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The network default fee (PLATFORM_FEE_PERCENT), for "inherited" labels. */
settlementsRouter.get(
  '/config',
  asyncHandler(async (_req, res) => {
    res.json({ defaultFeePercent: env.PLATFORM_FEE_PERCENT });
  }),
);

const summaryQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  clientId: z.string().optional(),
});

interface Earned {
  _id: Types.ObjectId;
  sessions: number;
  energyWh: number;
  gross: number;
  fee: number;
}

/** Completed sessions grouped by the client that owned the station when they ran. */
async function earnings(range: { from?: Date; to?: Date }, clientId?: string): Promise<Map<string, Earned>> {
  const stop: Record<string, Date> = {};
  if (range.from) stop.$gte = range.from;
  if (range.to) stop.$lt = range.to;

  const rows = await Transaction.aggregate<Earned>([
    { $match: { status: 'Completed', ...(Object.keys(stop).length ? { stopTimestamp: stop } : {}) } },
    // Sessions from before the client was snapshotted (field missing, not null)
    // fall back to the station's current client.
    { $lookup: { from: 'chargepoints', localField: 'chargePointId', foreignField: '_id', as: 'cp' } },
    {
      $addFields: {
        owner: {
          $cond: [{ $eq: [{ $type: '$clientId' }, 'missing'] }, { $first: '$cp.clientId' }, '$clientId'],
        },
      },
    },
    { $match: { owner: clientId ? new Types.ObjectId(clientId) : { $ne: null } } },
    {
      $group: {
        _id: '$owner',
        sessions: { $sum: 1 },
        energyWh: { $sum: { $ifNull: ['$energyWh', 0] } },
        gross: { $sum: { $ifNull: ['$cost', 0] } },
        fee: { $sum: { $ifNull: ['$feeAmount', 0] } },
      },
    },
  ]);
  return new Map(rows.map((r) => [String(r._id), r]));
}

settlementsRouter.get(
  '/summary',
  validate(summaryQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof summaryQuery>;
    if (q.clientId && !isValidObjectId(q.clientId)) throw badRequest('Invalid clientId');

    const [period, allTime, paid, clients] = await Promise.all([
      earnings({ from: q.from, to: q.to }, q.clientId),
      earnings({}, q.clientId),
      Settlement.aggregate<{ _id: Types.ObjectId; paid: number; lastPaidAt: Date }>([
        ...(q.clientId ? [{ $match: { clientId: new Types.ObjectId(q.clientId) } }] : []),
        { $group: { _id: '$clientId', paid: { $sum: '$amount' }, lastPaidAt: { $max: '$paidAt' } } },
      ]),
      Client.find(q.clientId ? { _id: q.clientId } : {})
        .select('name businessRegister feePercent payoutAccount isActive')
        .sort({ name: 1 })
        .lean(),
    ]);
    const paidBy = new Map(paid.map((p) => [String(p._id), p]));

    const data = clients.map((c) => {
      const id = String(c._id);
      const p = period.get(id);
      const a = allTime.get(id);
      const gross = round2(p?.gross ?? 0);
      const fee = round2(p?.fee ?? 0);
      const earnedTotal = round2((a?.gross ?? 0) - (a?.fee ?? 0));
      const paidTotal = round2(paidBy.get(id)?.paid ?? 0);
      return {
        client: {
          id,
          name: c.name,
          businessRegister: c.businessRegister ?? undefined,
          feePercent: c.feePercent ?? undefined,
          payoutAccount: c.payoutAccount ?? undefined,
          isActive: c.isActive,
        },
        period: {
          sessions: p?.sessions ?? 0,
          energyWh: p?.energyWh ?? 0,
          gross,
          fee,
          net: round2(gross - fee),
        },
        earnedTotal,
        paidTotal,
        outstanding: round2(earnedTotal - paidTotal),
        lastPaidAt: paidBy.get(id)?.lastPaidAt ?? null,
      };
    });

    const totals = data.reduce(
      (t, r) => ({
        sessions: t.sessions + r.period.sessions,
        gross: round2(t.gross + r.period.gross),
        fee: round2(t.fee + r.period.fee),
        net: round2(t.net + r.period.net),
        outstanding: round2(t.outstanding + r.outstanding),
      }),
      { sessions: 0, gross: 0, fee: 0, net: 0, outstanding: 0 },
    );

    res.json({ from: q.from ?? null, to: q.to ?? null, defaultFeePercent: env.PLATFORM_FEE_PERCENT, data, totals });
  }),
);

const listQuery = z.object({
  clientId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

settlementsRouter.get(
  '/',
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    if (q.clientId && !isValidObjectId(q.clientId)) throw badRequest('Invalid clientId');
    const rows = await Settlement.find(q.clientId ? { clientId: q.clientId } : {})
      .sort({ paidAt: -1 })
      .limit(q.limit);
    res.json({ data: rows.map((r) => r.toJSON()) });
  }),
);

const createSchema = z.object({
  clientId: z.string(),
  amount: z.number().positive('Дүн 0-ээс их байх ёстой'),
  periodFrom: z.coerce.date().optional(),
  periodTo: z.coerce.date().optional(),
  reference: z.string().max(100).optional(),
  note: z.string().max(500).optional(),
  paidAt: z.coerce.date().optional(),
});

/** Record a payout made to a client. Admin only: it is a money record. */
settlementsRouter.post(
  '/',
  requireAdmin,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createSchema>;
    if (!isValidObjectId(body.clientId) || !(await Client.exists({ _id: body.clientId }))) {
      throw badRequest('Client not found');
    }
    const created = await Settlement.create({ ...body, createdBy: req.user?.email ?? 'admin' });
    res.status(201).json(created.toJSON());
  }),
);

/** Remove a payout entered by mistake. */
settlementsRouter.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    if (!isValidObjectId(req.params.id)) throw badRequest('Invalid id');
    const removed = await Settlement.findByIdAndDelete(req.params.id);
    if (!removed) throw notFound('Settlement not found');
    res.status(204).end();
  }),
);

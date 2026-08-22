import { Router } from 'express';
import { cpIdsFor, requireChargePointRef } from '../../lib/chargePointRef';
import { z } from 'zod';
import { ChargePoint } from '../../models/ChargePoint';
import { ChargingProfile } from '../../models/ChargingProfile';
import { Connector } from '../../models/Connector';
import { DiagnosticsJob, FirmwareJob } from '../../models/Job';
import { MeterValue } from '../../models/MeterValue';
import { Reservation } from '../../models/Reservation';
import { SecurityEvent } from '../../models/Security';
import { Transaction } from '../../models/Transaction';
import { RESERVATION_STATES } from '../../models/enums';
import { connectionManager } from '../../ocpp/manager';
import {
  asyncHandler,
  paginate,
  paginationSchema,
  requireAuth,
  requireOperator,
  validate,
} from '../middleware';

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

export const reservationsRouter = Router();
reservationsRouter.use(requireAuth);

const reservationQuery = paginationSchema.extend({
  chargePointId: z.string().optional(),
  state: z.enum(RESERVATION_STATES).optional(),
});

reservationsRouter.get(
  '/',
  validate(reservationQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof reservationQuery>;
    const filter: Record<string, unknown> = {};
    if (q.chargePointId) filter.chargePointId = await requireChargePointRef(q.chargePointId);
    if (q.state) filter.state = q.state;

    const { skip, limit } = paginate(q);
    const [data, total] = await Promise.all([
      Reservation.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Reservation.countDocuments(filter),
    ]);
    res.json({
      data: data.map((r) => ({ ...r, reservationId: r._id, id: r._id })),
      total,
      page: q.page,
      limit: q.limit,
    });
  }),
);

// ---------------------------------------------------------------------------
// Charging profiles
// ---------------------------------------------------------------------------

export const chargingProfilesRouter = Router();
chargingProfilesRouter.use(requireAuth);

chargingProfilesRouter.get(
  '/',
  validate(paginationSchema.extend({ chargePointId: z.string().optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof paginationSchema> & {
      chargePointId?: string;
    };
    const filter: Record<string, unknown> = {};
    if (q.chargePointId) filter.chargePointId = await requireChargePointRef(q.chargePointId);

    const { skip, limit } = paginate(q);
    const [data, total] = await Promise.all([
      ChargingProfile.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      ChargingProfile.countDocuments(filter),
    ]);
    res.json({ data, total, page: q.page, limit: q.limit });
  }),
);

// ---------------------------------------------------------------------------
// Firmware / diagnostics jobs
// ---------------------------------------------------------------------------

export const jobsRouter = Router();
jobsRouter.use(requireAuth);

const jobQuery = paginationSchema.extend({ chargePointId: z.string().optional() });

jobsRouter.get(
  '/firmware',
  validate(jobQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof jobQuery>;
    const filter = q.chargePointId
      ? { chargePointId: await requireChargePointRef(q.chargePointId) }
      : {};
    const { skip, limit } = paginate(q);
    const [data, total] = await Promise.all([
      FirmwareJob.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      FirmwareJob.countDocuments(filter),
    ]);
    res.json({ data, total, page: q.page, limit: q.limit });
  }),
);

jobsRouter.get(
  '/diagnostics',
  validate(jobQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof jobQuery>;
    const filter = q.chargePointId
      ? { chargePointId: await requireChargePointRef(q.chargePointId) }
      : {};
    const { skip, limit } = paginate(q);
    const [data, total] = await Promise.all([
      DiagnosticsJob.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      DiagnosticsJob.countDocuments(filter),
    ]);
    res.json({ data, total, page: q.page, limit: q.limit });
  }),
);

// ---------------------------------------------------------------------------
// Meter values
// ---------------------------------------------------------------------------

export const meterValuesRouter = Router();
meterValuesRouter.use(requireAuth);

const meterQuery = paginationSchema.extend({
  chargePointId: z.string().optional(),
  connectorId: z.coerce.number().int().optional(),
  transactionId: z.coerce.number().int().optional(),
  measurand: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

meterValuesRouter.get(
  '/',
  validate(meterQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof meterQuery>;
    const filter: Record<string, unknown> = {};
    if (q.chargePointId) filter.chargePointId = await requireChargePointRef(q.chargePointId);
    if (q.connectorId !== undefined) filter.connectorId = q.connectorId;
    if (q.transactionId !== undefined) filter.transactionId = q.transactionId;
    if (q.measurand) filter['sampledValue.measurand'] = q.measurand;
    if (q.from || q.to) {
      filter.timestamp = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
    }

    const { skip, limit } = paginate(q);
    const [data, total] = await Promise.all([
      MeterValue.find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
      MeterValue.countDocuments(filter),
    ]);
    res.json({ data, total, page: q.page, limit: q.limit });
  }),
);

// ---------------------------------------------------------------------------
// Dashboard statistics
// ---------------------------------------------------------------------------

export const statsRouter = Router();
statsRouter.use(requireAuth);

statsRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      chargePoints,
      online,
      connectorsByStatus,
      activeTransactions,
      transactions24h,
      energyAgg,
      criticalEvents,
    ] = await Promise.all([
      ChargePoint.countDocuments({}),
      ChargePoint.countDocuments({ isOnline: true }),
      Connector.aggregate([
        { $match: { connectorId: { $gt: 0 } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Transaction.countDocuments({ status: 'Active' }),
      Transaction.countDocuments({ startTimestamp: { $gte: since24h } }),
      Transaction.aggregate([
        { $match: { status: 'Completed', stopTimestamp: { $gte: since24h } } },
        {
          $group: {
            _id: null,
            energyWh: { $sum: '$energyWh' },
            cost: { $sum: { $ifNull: ['$cost', 0] } },
            count: { $sum: 1 },
          },
        },
      ]),
      SecurityEvent.countDocuments({ isCritical: true, acknowledged: false }),
    ]);

    res.json({
      chargePoints: { total: chargePoints, online, offline: chargePoints - online },
      liveConnections: connectionManager.size,
      connectors: Object.fromEntries(
        connectorsByStatus.map((c: { _id: string; count: number }) => [c._id, c.count]),
      ),
      transactions: {
        active: activeTransactions,
        last24h: transactions24h,
        completedLast24h: energyAgg[0]?.count ?? 0,
      },
      energyLast24hKwh: Number((((energyAgg[0]?.energyWh ?? 0) as number) / 1000).toFixed(3)),
      revenueLast24h: Number(((energyAgg[0]?.cost ?? 0) as number).toFixed(2)),
      unacknowledgedCriticalSecurityEvents: criticalEvents,
    });
  }),
);

const seriesQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  chargePointId: z.string().optional(),
});

statsRouter.get(
  '/energy-series',
  validate(seriesQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof seriesQuery>;
    const since = new Date(Date.now() - q.days * 24 * 60 * 60 * 1000);
    const match: Record<string, unknown> = {
      status: 'Completed',
      stopTimestamp: { $gte: since },
    };
    if (q.chargePointId) match.chargePointId = await requireChargePointRef(q.chargePointId);

    const data = await Transaction.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$stopTimestamp' } },
          energyWh: { $sum: '$energyWh' },
          sessions: { $sum: 1 },
          cost: { $sum: { $ifNull: ['$cost', 0] } },
        },
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          _id: 0,
          date: '$_id',
          energyKwh: { $divide: ['$energyWh', 1000] },
          sessions: 1,
          cost: 1,
        },
      },
    ]);
    res.json(data);
  }),
);

statsRouter.get(
  '/top-charge-points',
  validate(seriesQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof seriesQuery>;
    const since = new Date(Date.now() - q.days * 24 * 60 * 60 * 1000);
    const data = await Transaction.aggregate([
      { $match: { status: 'Completed', stopTimestamp: { $gte: since } } },
      {
        $group: {
          _id: '$chargePointId',
          energyWh: { $sum: '$energyWh' },
          sessions: { $sum: 1 },
          cost: { $sum: { $ifNull: ['$cost', 0] } },
        },
      },
      { $sort: { energyWh: -1 } },
      { $limit: 20 },
      {
        $project: {
          _id: 0,
          chargePointId: '$_id',
          energyKwh: { $divide: ['$energyWh', 1000] },
          sessions: 1,
          cost: 1,
        },
      },
    ]);

    // Grouping happens on the reference; the reply names the stations.
    const labels = await cpIdsFor(data.map((row: { chargePointId?: unknown }) => row.chargePointId as string));
    res.json(
      data.map((row: { chargePointId?: unknown }) => ({
        ...row,
        id: String(row.chargePointId),
        chargePointId: labels.get(String(row.chargePointId)) ?? String(row.chargePointId),
      })),
    );
  }),
);

// ---------------------------------------------------------------------------
// Connectors (flat listing across all charge points)
// ---------------------------------------------------------------------------

export const connectorsRouter = Router();
connectorsRouter.use(requireAuth);

connectorsRouter.get(
  '/',
  validate(
    paginationSchema.extend({ chargePointId: z.string().optional(), status: z.string().optional() }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof paginationSchema> & {
      chargePointId?: string;
      status?: string;
    };
    const filter: Record<string, unknown> = {};
    if (q.chargePointId) filter.chargePointId = await requireChargePointRef(q.chargePointId);
    if (q.status) filter.status = q.status;

    const { skip, limit } = paginate(q);
    const [data, total] = await Promise.all([
      Connector.find(filter)
        .sort({ chargePointId: 1, connectorId: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Connector.countDocuments(filter),
    ]);
    res.json({ data, total, page: q.page, limit: q.limit });
  }),
);

export { requireOperator };

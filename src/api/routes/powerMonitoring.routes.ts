import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { notFound, badRequest } from '../../lib/errors';
import { ChargePoint } from '../../models/ChargePoint';
import { Connector } from '../../models/Connector';
import { PowerAlert } from '../../models/PowerAlert';
import {
  getNetworkPowerSummary,
  getStationPowerList,
  getStationPowerDetail,
  getHistoricalPowerAnalytics,
} from '../../services/powerMonitoring.service';
import { getStationPowerStats, StatsRangeError } from '../../services/stationPowerStats.service';
import {
  asyncHandler,
  requireAuth,
  requireOperator,
  validate,
} from '../middleware';
import type { AuthPrincipal } from '../middleware/auth';

export const powerMonitoringRouter = Router();
powerMonitoringRouter.use(requireAuth);

function extractClientFilter(user: AuthPrincipal | undefined) {
  if ((user?.role === 'CLIENT' || user?.clientId) && user.clientId) {
    const cId = new Types.ObjectId(user.clientId);
    return { clientId: cId, linkedClientIds: cId };
  }
  return undefined;
}

/**
 * GET /api/power-monitoring/summary
 * Returns network-wide top-level KPIs.
 */
powerMonitoringRouter.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const clientFilter = extractClientFilter(req.user);
    const summary = await getNetworkPowerSummary(clientFilter);
    res.json(summary);
  }),
);

/**
 * GET /api/power-monitoring/stations
 * Returns station-level power monitoring list.
 */
powerMonitoringRouter.get(
  '/stations',
  asyncHandler(async (req, res) => {
    const clientFilter = extractClientFilter(req.user);
    const search = req.query.search as string | undefined;
    const list = await getStationPowerList(clientFilter, search);
    res.json(list);
  }),
);

/**
 * GET /api/power-monitoring/stations/:id
 * Detailed power monitoring for a specific station.
 */
powerMonitoringRouter.get(
  '/stations/:id',
  asyncHandler(async (req, res) => {
    const clientFilter = extractClientFilter(req.user);
    const detail = await getStationPowerDetail(req.params.id, clientFilter);
    if (!detail) throw notFound('Station not found');
    res.json(detail);
  }),
);

const analyticsQuery = z.object({
  stationId: z.string().optional(),
  range: z.enum(['15m', '1h', '6h', '24h', '7d', '30d', 'custom']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/**
 * GET /api/power-monitoring/analytics
 * Historical power consumption and multi-pile breakdown time-series.
 */
powerMonitoringRouter.get(
  '/analytics',
  validate(analyticsQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof analyticsQuery>;
    const analytics = await getHistoricalPowerAnalytics({
      stationRef: q.stationId,
      range: q.range ?? '1h',
      from: q.from,
      to: q.to,
    });
    res.json(analytics);
  }),
);

const statsQuery = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
});

/**
 * GET /api/power-monitoring/stations/:id/stats?from=&to=
 * Peak / average / low kW per day and per gun, and how guns share power
 * when they charge at the same time. Range up to 31 days.
 */
powerMonitoringRouter.get(
  '/stations/:id/stats',
  validate(statsQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof statsQuery>;
    try {
      const stats = await getStationPowerStats({
        stationRef: req.params.id,
        from: q.from,
        to: q.to,
        clientFilter: extractClientFilter(req.user),
      });
      if (!stats) throw notFound('Station not found');
      res.json(stats);
    } catch (err) {
      if (err instanceof StatsRangeError) throw badRequest(err.message);
      throw err;
    }
  }),
);

const alertQuery = z.object({
  stationId: z.string().optional(),
  status: z.enum(['ACTIVE', 'ACKNOWLEDGED', 'RESOLVED', 'ALL']).optional(),
  severity: z.enum(['CRITICAL', 'WARNING', 'INFO', 'ALL']).optional(),
});

/**
 * GET /api/power-monitoring/alerts
 * Operational alerts and anomalies.
 */
powerMonitoringRouter.get(
  '/alerts',
  validate(alertQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof alertQuery>;
    const filter: Record<string, unknown> = {};

    if (q.stationId) {
      if (Types.ObjectId.isValid(q.stationId)) {
        filter.chargePointId = new Types.ObjectId(q.stationId);
      } else {
        filter.cpId = q.stationId;
      }
    }
    if (q.status && q.status !== 'ALL') {
      filter.status = q.status;
    } else {
      filter.status = { $in: ['ACTIVE', 'ACKNOWLEDGED'] };
    }
    if (q.severity && q.severity !== 'ALL') {
      filter.severity = q.severity;
    }

    const alerts = await PowerAlert.find(filter).sort({ lastSeenAt: -1 }).limit(100).lean();
    res.json(
      alerts.map((a) => ({
        ...a,
        id: String(a._id),
      })),
    );
  }),
);

const updateAlertSchema = z.object({
  status: z.enum(['ACKNOWLEDGED', 'RESOLVED']),
});

/**
 * PATCH /api/power-monitoring/alerts/:id
 * Acknowledge or resolve an operational alert.
 */
powerMonitoringRouter.patch(
  '/alerts/:id',
  requireOperator,
  validate(updateAlertSchema, 'body'),
  asyncHandler(async (req, res) => {
    const { status } = req.body as z.infer<typeof updateAlertSchema>;
    const alert = await PowerAlert.findById(req.params.id);
    if (!alert) throw notFound('Alert not found');

    alert.status = status;
    if (status === 'RESOLVED') {
      alert.resolvedAt = new Date();
      alert.resolvedBy = req.user?.email || 'operator';
    }
    await alert.save();
    res.json({ success: true, alert });
  }),
);

const electricalConfigSchema = z.object({
  ratedCapacityKW: z.number().min(1).max(2000),
  configuredGridLimitKW: z.number().min(1).max(2000),
  inputMeterAvailable: z.boolean().optional(),
  inputMeterId: z.string().optional(),
  powerSharingEnabled: z.boolean().optional(),
  powerSharingMode: z.enum(['EQUAL', 'DYNAMIC_DEMAND', 'PRIORITY', 'FIFO']).optional(),
  maximumSimultaneousSessions: z.number().int().min(1).max(20).optional(),
  warningThresholds: z
    .object({
      highUtilizationPct: z.number().min(10).max(100).optional(),
      overloadPct: z.number().min(50).max(150).optional(),
      underperformancePct: z.number().min(10).max(90).optional(),
      minVoltageV: z.number().min(100).max(500).optional(),
      maxVoltageV: z.number().min(500).max(1200).optional(),
      maxCurrentA: z.number().min(10).max(1000).optional(),
    })
    .optional(),
  piles: z
    .array(
      z.object({
        connectorId: z.number().int().min(1),
        ratedPowerKw: z.number().min(1).max(1000),
        configuredPowerLimitKw: z.number().min(1).max(1000).optional(),
      }),
    )
    .optional(),
});

/**
 * PUT /api/power-monitoring/stations/:id/electrical-config
 * Updates station electrical specs and pile power configurations.
 */
powerMonitoringRouter.put(
  '/stations/:id/electrical-config',
  requireOperator,
  validate(electricalConfigSchema, 'body'),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof electricalConfigSchema>;
    const stationId = req.params.id;

    const cp = await ChargePoint.findOne(
      Types.ObjectId.isValid(stationId) ? { _id: new Types.ObjectId(stationId) } : { cpId: stationId },
    );
    if (!cp) throw notFound('Station not found');

    // Validation: configuredGridLimitKW cannot exceed reasonable physical capacity
    if (body.configuredGridLimitKW > body.ratedCapacityKW * 1.25) {
      throw badRequest('Configured grid limit cannot exceed station rated capacity by more than 25%');
    }

    cp.electricalConfig = {
      ratedCapacityKW: body.ratedCapacityKW,
      configuredGridLimitKW: body.configuredGridLimitKW,
      inputMeterAvailable: body.inputMeterAvailable ?? cp.electricalConfig?.inputMeterAvailable ?? false,
      inputMeterId: body.inputMeterId ?? cp.electricalConfig?.inputMeterId,
      powerSharingEnabled: body.powerSharingEnabled ?? cp.electricalConfig?.powerSharingEnabled ?? true,
      powerSharingMode: body.powerSharingMode ?? cp.electricalConfig?.powerSharingMode ?? 'DYNAMIC_DEMAND',
      maximumSimultaneousSessions: body.maximumSimultaneousSessions ?? cp.electricalConfig?.maximumSimultaneousSessions ?? 2,
      warningThresholds: {
        highUtilizationPct: body.warningThresholds?.highUtilizationPct ?? cp.electricalConfig?.warningThresholds?.highUtilizationPct ?? 80,
        overloadPct: body.warningThresholds?.overloadPct ?? cp.electricalConfig?.warningThresholds?.overloadPct ?? 95,
        underperformancePct: body.warningThresholds?.underperformancePct ?? cp.electricalConfig?.warningThresholds?.underperformancePct ?? 50,
        minVoltageV: body.warningThresholds?.minVoltageV ?? cp.electricalConfig?.warningThresholds?.minVoltageV ?? 320,
        maxVoltageV: body.warningThresholds?.maxVoltageV ?? cp.electricalConfig?.warningThresholds?.maxVoltageV ?? 850,
        maxCurrentA: body.warningThresholds?.maxCurrentA ?? cp.electricalConfig?.warningThresholds?.maxCurrentA ?? 250,
      },
    };
    await cp.save();

    if (body.piles && body.piles.length > 0) {
      for (const p of body.piles) {
        await Connector.updateOne(
          { chargePointId: cp._id, connectorId: p.connectorId },
          {
            $set: {
              powerKw: p.ratedPowerKw,
              ratedPowerKw: p.ratedPowerKw,
              configuredPowerLimitKw: p.configuredPowerLimitKw ?? p.ratedPowerKw,
            },
          },
        );
      }
    }

    res.json({ success: true, electricalConfig: cp.electricalConfig });
  }),
);

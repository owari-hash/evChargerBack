import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { badRequest, notFound, unauthorized } from '../../lib/errors';
import {
  PartnerMerchant,
  verifyPartnerPassword,
} from '../../models/PartnerMerchant';
import {
  issuePartnerTokens,
  rotatePartnerRefreshToken,
  revokeAllPartnerTokens,
  requirePartnerAuth,
  requirePartnerScope,
} from '../middleware/partnerAuth';
import { asyncHandler, validate } from '../middleware';
import { ChargePoint } from '../../models/ChargePoint';
import { Connector } from '../../models/Connector';
import { Transaction } from '../../models/Transaction';
import { connectionManager } from '../../ocpp/manager';
import { IdTag } from '../../models/IdTag';

export const partnerRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Хэт олон нэвтрэх оролдлого хийсэн байна. Түр хүлээнэ үү' },
});

// ---------------------------------------------------------------------------
// 1. Partner Auth: Login, Refresh, Revoke
// ---------------------------------------------------------------------------

const partnerLoginSchema = z.object({
  username: z.string().min(1, 'Хэрэглэгчийн нэр оруулна уу'),
  password: z.string().min(1, 'Нууц үг оруулна уу'),
});

partnerRouter.post(
  '/auth/login',
  loginLimiter,
  validate(partnerLoginSchema),
  asyncHandler(async (req, res) => {
    const { username, password } = req.body as z.infer<typeof partnerLoginSchema>;
    const merchant = await PartnerMerchant.findOne({ username: username.toLowerCase() }).select('+passwordHash');

    if (!merchant || !(await verifyPartnerPassword(password, merchant.passwordHash))) {
      throw unauthorized('Хэрэглэгчийн нэр эсвэл нууц үг буруу байна');
    }

    if (!merchant.isActive) {
      throw unauthorized('Мерчантын эрх хаагдсан байна. Eplug админтай холбогдоно уу');
    }

    const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip;
    const userAgent = req.header('user-agent');

    merchant.lastLoginAt = new Date();
    await merchant.save();

    const tokenResponse = await issuePartnerTokens(merchant, clientIp, userAgent);
    res.json(tokenResponse);
  }),
);

const partnerRefreshSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken шаардлагатай'),
});

partnerRouter.post(
  '/auth/refresh',
  validate(partnerRefreshSchema),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body as z.infer<typeof partnerRefreshSchema>;
    const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip;
    const userAgent = req.header('user-agent');

    const rotated = await rotatePartnerRefreshToken(refreshToken, clientIp, userAgent);
    res.json(rotated);
  }),
);

partnerRouter.post(
  '/auth/revoke',
  requirePartnerAuth,
  asyncHandler(async (req, res) => {
    await revokeAllPartnerTokens(String(req.partnerMerchant!._id));
    res.json({ ok: true, message: 'Бүх идэвхтэй токен цуцлагдлаа' });
  }),
);

// ---------------------------------------------------------------------------
// 2. Merchant Profile
// ---------------------------------------------------------------------------

partnerRouter.get(
  '/me',
  requirePartnerAuth,
  asyncHandler(async (req, res) => {
    const m = req.partnerMerchant!;
    res.json({
      id: String(m._id),
      name: m.name,
      code: m.code,
      username: m.username,
      scopes: m.allowedScopes,
      allowedStations: m.allowedStations,
      rateLimitPerMin: m.rateLimitPerMin,
      totalApiCalls: m.totalApiCalls,
      lastLoginAt: m.lastLoginAt,
    });
  }),
);

// ---------------------------------------------------------------------------
// 3. Stations API
// ---------------------------------------------------------------------------

partnerRouter.get(
  '/stations',
  requirePartnerAuth,
  requirePartnerScope('stations:read'),
  asyncHandler(async (req, res) => {
    const m = req.partnerMerchant!;
    const filter: Record<string, unknown> = {};

    // If merchant has station restrictions, scope to their allowed stations
    if (m.allowedStations && m.allowedStations.length > 0) {
      filter.$or = [
        { cpId: { $in: m.allowedStations } },
        { _id: { $in: m.allowedStations.filter((s) => s.match(/^[0-9a-fA-F]{24}$/)) } },
      ];
    }

    const stations = await ChargePoint.find(filter)
      .select('cpId name address latitude longitude chargePointVendor chargePointModel tariffPerKwh isOnline status')
      .lean();

    const stationDbIds = stations.map((s) => s._id);
    const connectors = await Connector.find({ chargePointId: { $in: stationDbIds } }).lean();

    const connectorsByStId = new Map<string, typeof connectors>();
    for (const c of connectors) {
      const key = String(c.chargePointId);
      const list = connectorsByStId.get(key) || [];
      list.push(c);
      connectorsByStId.set(key, list);
    }

    const results = stations.map((st) => {
      const stConnectors = connectorsByStId.get(String(st._id)) || [];
      const isOnline = connectionManager.isOnline(st.cpId);

      return {
        id: String(st._id),
        cpId: st.cpId,
        name: st.name || st.cpId,
        address: st.address || '',
        latitude: st.latitude,
        longitude: st.longitude,
        vendor: st.chargePointVendor,
        model: st.chargePointModel,
        tariffPerKwh: st.tariffPerKwh,
        isOnline,
        connectors: stConnectors.map((c) => ({
          connectorId: c.connectorId,
          type: c.connectorType,
          powerKw: c.powerKw,
          status: isOnline ? c.status : 'Unavailable',
          errorCode: c.errorCode,
        })),
      };
    });

    res.json({ stations: results, total: results.length });
  }),
);

partnerRouter.get(
  '/stations/:cpId',
  requirePartnerAuth,
  requirePartnerScope('stations:read'),
  asyncHandler(async (req, res) => {
    const m = req.partnerMerchant!;
    const cpId = req.params.cpId;

    if (m.allowedStations && m.allowedStations.length > 0) {
      if (!m.allowedStations.includes(cpId)) {
        throw notFound('Станц олдсонгүй эсвэл хандах эрхгүй байна');
      }
    }

    const st = await ChargePoint.findOne({ cpId }).lean();
    if (!st) throw notFound('Станц олдсонгүй');

    const connectors = await Connector.find({ chargePointId: st._id }).lean();
    const isOnline = connectionManager.isOnline(cpId);

    res.json({
      id: String(st._id),
      cpId: st.cpId,
      name: st.name || st.cpId,
      address: st.address || '',
      latitude: st.latitude,
      longitude: st.longitude,
      vendor: st.chargePointVendor,
      model: st.chargePointModel,
      tariffPerKwh: st.tariffPerKwh,
      isOnline,
      connectors: connectors.map((c) => ({
        connectorId: c.connectorId,
        type: c.connectorType,
        powerKw: c.powerKw,
        status: isOnline ? c.status : 'Unavailable',
        errorCode: c.errorCode,
      })),
    });
  }),
);

// ---------------------------------------------------------------------------
// 4. Remote Start & Stop Session API
// ---------------------------------------------------------------------------

const startSessionSchema = z.object({
  cpId: z.string().min(1, 'Станцын ID (cpId) шаардлагатай'),
  connectorId: z.number().int().positive().default(1),
  idTag: z.string().optional(),
});

partnerRouter.post(
  '/sessions/start',
  requirePartnerAuth,
  requirePartnerScope('sessions:control'),
  validate(startSessionSchema),
  asyncHandler(async (req, res) => {
    const m = req.partnerMerchant!;
    const { cpId, connectorId, idTag } = req.body as z.infer<typeof startSessionSchema>;

    if (m.allowedStations && m.allowedStations.length > 0) {
      if (!m.allowedStations.includes(cpId)) {
        throw badRequest(`Станц "${cpId}" дээр цэнэглэлт эхлүүлэх эрх олгогдоогүй байна`);
      }
    }

    if (!connectionManager.isOnline(cpId)) {
      throw badRequest(`Станц "${cpId}" одоогоор холболтгүй (offline) байна`);
    }

    // Use partner specific tag or merchant tag
    const tagToUse = idTag || `PM-${m.code.toUpperCase()}`;

    // Ensure tag exists in IdTag registry
    const existingTag = await IdTag.findById(tagToUse);
    if (!existingTag) {
      await IdTag.create({
        _id: tagToUse,
        status: 'Accepted',
        driverName: `${m.name} (Partner)`,
      });
    }

    const commandIssuer = `partner:${m.username}`;
    const result = await connectionManager.send(
      cpId,
      'RemoteStartTransaction',
      { idTag: tagToUse, connectorId },
      commandIssuer,
    );

    res.json({
      ok: (result as any)?.status === 'Accepted',
      cpId,
      connectorId,
      idTag: tagToUse,
      ocppResponse: result,
    });
  }),
);

const stopSessionSchema = z.object({
  transactionId: z.number().int().positive('Гүйлгээний дугаар (transactionId) шаардлагатай'),
});

partnerRouter.post(
  '/sessions/stop',
  requirePartnerAuth,
  requirePartnerScope('sessions:control'),
  validate(stopSessionSchema),
  asyncHandler(async (req, res) => {
    const m = req.partnerMerchant!;
    const { transactionId } = req.body as z.infer<typeof stopSessionSchema>;

    const tx = await Transaction.findById(transactionId).lean();
    if (!tx) throw notFound('Цэнэглэлтийн сесс олдсонгүй');

    const st = await ChargePoint.findById(tx.chargePointId).lean();
    if (!st) throw notFound('Станц олдсонгүй');

    if (m.allowedStations && m.allowedStations.length > 0) {
      if (!m.allowedStations.includes(st.cpId)) {
        throw badRequest(`Энэ станцын сессийг зогсоох эрхгүй байна`);
      }
    }

    if (!connectionManager.isOnline(st.cpId)) {
      throw badRequest(`Станц "${st.cpId}" одоогоор холболтгүй (offline) байна`);
    }

    const commandIssuer = `partner:${m.username}`;
    const result = await connectionManager.send(
      st.cpId,
      'RemoteStopTransaction',
      { transactionId },
      commandIssuer,
    );

    if ((result as any)?.status === 'Accepted') {
      await Transaction.findByIdAndUpdate(transactionId, { $set: { stoppedRemotely: true } });
    }

    res.json({
      ok: (result as any)?.status === 'Accepted',
      transactionId,
      cpId: st.cpId,
      ocppResponse: result,
    });
  }),
);

// ---------------------------------------------------------------------------
// 5. Active Sessions & Session Telemetry API
// ---------------------------------------------------------------------------

partnerRouter.get(
  '/sessions/active',
  requirePartnerAuth,
  requirePartnerScope('sessions:read'),
  asyncHandler(async (req, res) => {
    const m = req.partnerMerchant!;
    const filter: Record<string, unknown> = {
      stopTimestamp: null,
    };

    if (m.allowedStations && m.allowedStations.length > 0) {
      const allowedCps = await ChargePoint.find({ cpId: { $in: m.allowedStations } }).select('_id').lean();
      filter.chargePointId = { $in: allowedCps.map((c) => c._id) };
    }

    const activeTxs = await Transaction.find(filter)
      .populate('chargePointId', 'cpId name')
      .sort({ startTimestamp: -1 })
      .limit(50)
      .lean();

    res.json({
      sessions: activeTxs.map((tx: any) => ({
        transactionId: tx._id,
        cpId: tx.chargePointId?.cpId || '',
        stationName: tx.chargePointId?.name || '',
        connectorId: tx.connectorId,
        idTag: tx.idTag,
        startTimestamp: tx.startTimestamp,
        currentMeterWh: tx.lastMeterWh || tx.meterStart,
        energyKwh: Math.max(0, Math.round((((tx.lastMeterWh || tx.meterStart) - tx.meterStart) / 1000) * 100) / 100),
        currentSoc: tx.lastSocPercent,
      })),
      count: activeTxs.length,
    });
  }),
);

partnerRouter.get(
  '/sessions/:id',
  requirePartnerAuth,
  requirePartnerScope('sessions:read'),
  asyncHandler(async (req, res) => {
    const txId = Number(req.params.id);
    if (!Number.isInteger(txId)) throw badRequest('Буруу дугаар');

    const tx = await Transaction.findById(txId).populate('chargePointId', 'cpId name').lean();
    if (!tx) throw notFound('Сесс олдсонгүй');

    const m = req.partnerMerchant!;
    const cpId = (tx.chargePointId as any)?.cpId;

    if (m.allowedStations && m.allowedStations.length > 0 && cpId) {
      if (!m.allowedStations.includes(cpId)) {
        throw notFound('Сесс олдсонгүй');
      }
    }

    const currentWh = tx.meterStop || tx.lastMeterWh || tx.meterStart;
    const kwh = (currentWh - tx.meterStart) / 1000;

    res.json({
      transactionId: tx._id,
      cpId,
      stationName: (tx.chargePointId as any)?.name || '',
      connectorId: tx.connectorId,
      idTag: tx.idTag,
      startTimestamp: tx.startTimestamp,
      stopTimestamp: tx.stopTimestamp,
      energyKwh: Math.max(0, Math.round(kwh * 100) / 100),
      durationMin: tx.stopTimestamp
        ? Math.round((new Date(tx.stopTimestamp).getTime() - new Date(tx.startTimestamp).getTime()) / 60000)
        : Math.round((Date.now() - new Date(tx.startTimestamp).getTime()) / 60000),
      stopReason: tx.stopReason,
    });
  }),
);

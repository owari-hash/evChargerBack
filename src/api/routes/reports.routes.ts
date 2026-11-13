import { Router } from 'express';
import { isValidObjectId, Types } from 'mongoose';
import { z } from 'zod';
import { badRequest, forbidden } from '../../lib/errors';
import { ChargePoint } from '../../models/ChargePoint';
import { Client } from '../../models/Client';
import { DriverUser } from '../../driver/store';
import { IdTag } from '../../models/IdTag';
import { Payment } from '../../models/Payment';
import { Settlement } from '../../models/Settlement';
import { Transaction } from '../../models/Transaction';
import { asyncHandler, requireAuth, validate } from '../middleware';

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

const round2 = (n: number) => Math.round(n * 100) / 100;

const reportQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  chargePointId: z.string().optional(),
  clientId: z.string().optional(),
});

reportsRouter.get(
  '/summary',
  validate(reportQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof reportQuerySchema>;

    let targetClientId: string | undefined = q.clientId;
    if ((req.user?.role === 'CLIENT' || req.user?.clientId) && req.user.clientId) {
      targetClientId = req.user.clientId;
    }

    if (targetClientId && !isValidObjectId(targetClientId)) {
      throw badRequest('Invalid clientId');
    }

    // Resolve station filter if passed
    let stationFilterId: Types.ObjectId | null = null;
    if (q.chargePointId) {
      const cp = await ChargePoint.findOne(
        isValidObjectId(q.chargePointId)
          ? { _id: q.chargePointId }
          : { cpId: q.chargePointId },
      ).lean();
      if (!cp) throw badRequest('Charge point not found');

      if (req.user?.role === 'CLIENT') {
        const isOwner = String(cp.clientId ?? '') === String(targetClientId);
        const isLinked = (cp.linkedClientIds ?? []).some(
          (cid) => String(cid) === String(targetClientId),
        );
        if (!isOwner && !isLinked) throw forbidden('Access denied for this station');
      }
      stationFilterId = cp._id as Types.ObjectId;
    }

    // Build transaction query
    const txMatch: Record<string, unknown> = {
      status: 'Completed',
    };

    const stop: Record<string, Date> = {};
    if (q.from) stop.$gte = q.from;
    if (q.to) {
      let toDate = q.to;
      if (
        toDate &&
        toDate.getUTCHours() === 0 &&
        toDate.getUTCMinutes() === 0 &&
        toDate.getUTCSeconds() === 0 &&
        toDate.getUTCMilliseconds() === 0
      ) {
        toDate = new Date(toDate.getTime() + 24 * 60 * 60 * 1000);
      }
      stop.$lt = toDate;
    }
    if (Object.keys(stop).length) txMatch.stopTimestamp = stop;

    if (stationFilterId) {
      txMatch.chargePointId = stationFilterId;
    }

    // Aggregate sessions grouped by station
    const pipeline: any[] = [
      { $match: txMatch },
      {
        $lookup: {
          from: 'chargepoints',
          localField: 'chargePointId',
          foreignField: '_id',
          as: 'cp',
        },
      },
      {
        $addFields: {
          effectiveClientId: {
            $cond: [
              { $eq: [{ $type: '$clientId' }, 'missing'] },
              { $first: '$cp.clientId' },
              '$clientId',
            ],
          },
          cpDoc: { $first: '$cp' },
        },
      },
    ];

    if (targetClientId) {
      const clientOid = new Types.ObjectId(targetClientId);
      pipeline.push({
        $match: {
          $or: [
            { effectiveClientId: clientOid },
            { 'cpDoc.clientId': clientOid },
            { 'cpDoc.linkedClientIds': clientOid },
          ],
        },
      });
    }

    // Facet for station breakdown, daily breakdown, connector breakdown, and overall totals
    pipeline.push({
      $facet: {
        byStation: [
          {
            $group: {
              _id: '$chargePointId',
              cpId: { $first: '$cpDoc.cpId' },
              name: { $first: '$cpDoc.name' },
              address: { $first: '$cpDoc.address' },
              tariffPerKwh: { $first: '$cpDoc.tariffPerKwh' },
              stationFeePercent: { $first: '$cpDoc.feePercent' },
              sessions: { $sum: 1 },
              energyWh: { $sum: { $ifNull: ['$energyWh', 0] } },
              energyCost: { $sum: { $ifNull: ['$energyCost', 0] } },
              feeAmount: { $sum: { $ifNull: ['$feeAmount', 0] } },
              gross: { $sum: { $ifNull: ['$cost', 0] } },
            },
          },
          { $sort: { gross: -1 } },
        ],
        byDate: [
          {
            $group: {
              _id: {
                $dateToString: {
                  format: '%Y-%m-%d',
                  date: '$stopTimestamp',
                  timezone: '+08:00',
                },
              },
              sessions: { $sum: 1 },
              energyWh: { $sum: { $ifNull: ['$energyWh', 0] } },
              energyCost: { $sum: { $ifNull: ['$energyCost', 0] } },
              feeAmount: { $sum: { $ifNull: ['$feeAmount', 0] } },
              gross: { $sum: { $ifNull: ['$cost', 0] } },
            },
          },
          { $sort: { _id: 1 } },
        ],
        byConnector: [
          {
            $group: {
              _id: {
                chargePointId: '$chargePointId',
                connectorId: '$connectorId',
              },
              cpId: { $first: '$cpDoc.cpId' },
              stationName: { $first: '$cpDoc.name' },
              sessions: { $sum: 1 },
              energyWh: { $sum: { $ifNull: ['$energyWh', 0] } },
              gross: { $sum: { $ifNull: ['$cost', 0] } },
              feeAmount: { $sum: { $ifNull: ['$feeAmount', 0] } },
            },
          },
          { $sort: { gross: -1 } },
        ],
        recentSessions: [
          { $sort: { stopTimestamp: -1 } },
          { $limit: 500 },
          {
            $project: {
              _id: 1,
              chargePointId: 1,
              cpId: '$cpDoc.cpId',
              stationName: '$cpDoc.name',
              connectorId: 1,
              idTag: 1,
              vehicleModel: 1,
              startTimestamp: 1,
              stopTimestamp: 1,
              energyWh: 1,
              tariffPerKwh: 1,
              energyCost: 1,
              feePercent: 1,
              feeAmount: 1,
              cost: 1,
            },
          },
        ],
        totals: [
          {
            $group: {
              _id: null,
              sessions: { $sum: 1 },
              energyWh: { $sum: { $ifNull: ['$energyWh', 0] } },
              energyCost: { $sum: { $ifNull: ['$energyCost', 0] } },
              feeAmount: { $sum: { $ifNull: ['$feeAmount', 0] } },
              gross: { $sum: { $ifNull: ['$cost', 0] } },
            },
          },
        ],
      },
    });

    const [aggregateResult] = await Transaction.aggregate(pipeline);

    // Fetch settlements and client details if client is filtered or known
    let clientInfo: any = null;
    let paidTotal = 0;
    let lastPaidAt: Date | null = null;

    if (targetClientId) {
      const [client, paidAgg] = await Promise.all([
        Client.findById(targetClientId).select('name businessRegister feePercent payoutAccount').lean(),
        Settlement.aggregate([
          { $match: { clientId: new Types.ObjectId(targetClientId) } },
          { $group: { _id: '$clientId', paid: { $sum: '$amount' }, lastPaidAt: { $max: '$paidAt' } } },
        ]),
      ]);
      clientInfo = client;
      if (paidAgg.length > 0) {
        paidTotal = round2(paidAgg[0].paid ?? 0);
        lastPaidAt = paidAgg[0].lastPaidAt ?? null;
      }
    }

    const rawTotals = aggregateResult?.totals?.[0] ?? {
      sessions: 0,
      energyWh: 0,
      energyCost: 0,
      feeAmount: 0,
      gross: 0,
    };

    const totalEnergyWh = rawTotals.energyWh ?? 0;
    const totalEnergyKwh = round2(totalEnergyWh / 1000);
    const totalGross = round2(rawTotals.gross ?? 0);
    const totalFee = round2(rawTotals.feeAmount ?? 0);
    const totalNet = round2(totalGross - totalFee);
    const totalSessions = rawTotals.sessions ?? 0;
    const outstanding = round2(totalNet - paidTotal);

    // Format stations with calculation formulas
    const stations = (aggregateResult?.byStation ?? []).map((s: any) => {
      const wh = s.energyWh ?? 0;
      const kwh = round2(wh / 1000);
      const gross = round2(s.gross ?? 0);
      const fee = round2(s.feeAmount ?? 0);
      const net = round2(gross - fee);
      const energyCost = round2(s.energyCost ?? (gross - fee));
      const feePct = s.stationFeePercent ?? clientInfo?.feePercent ?? 0;

      const stationSessions = (aggregateResult?.recentSessions ?? [])
        .filter((tx: any) => String(tx.chargePointId) === String(s._id))
        .map((tx: any) => ({
          id: tx._id,
          connectorId: tx.connectorId,
          idTag: tx.idTag,
          vehicleModel: tx.vehicleModel,
          startTimestamp: tx.startTimestamp,
          stopTimestamp: tx.stopTimestamp,
          energyKwh: round2((tx.energyWh ?? 0) / 1000),
          tariffPerKwh: tx.tariffPerKwh,
          cost: round2(tx.cost ?? 0),
          feeAmount: round2(tx.feeAmount ?? 0),
          clientNet: round2((tx.cost ?? 0) - (tx.feeAmount ?? 0)),
        }));

      return {
        chargePointId: String(s._id),
        cpId: s.cpId ?? String(s._id),
        name: s.name ?? s.cpId ?? 'Станц',
        address: s.address ?? '',
        tariffPerKwh: s.tariffPerKwh ?? 0,
        sessionsCount: s.sessions,
        energyWh: wh,
        energyKwh: kwh,
        energyCost,
        feePercent: feePct,
        feeAmount: fee,
        gross,
        clientNet: net,
        sessions: stationSessions,
        formula: {
          kwhFormula: `${wh} Вт.ц ÷ 1,000 = ${kwh} кВт.ц`,
          grossFormula: `${kwh} кВт.ц × ${s.tariffPerKwh ?? 0}₮ = ${gross}₮ (хэрэглэгч төлсөн)`,
          feeFormula: `${gross}₮ × ${feePct}% = ${fee}₮ (Eplug шимтгэл)`,
          energyCostFormula: `${gross}₮ - ${fee}₮ = ${energyCost}₮ (харилцагчийн орлого)`,
          netFormula: `${gross}₮ - ${fee}₮ = ${net}₮`,
          summaryDisplay: `Хэрэглэгч төлсөн (${gross.toLocaleString()}₮): Харилцагч (${net.toLocaleString()}₮) + Eplug шимтгэл (${fee.toLocaleString()}₮)`,
        },
      };
    });

    // Format daily breakdown
    const daily = (aggregateResult?.byDate ?? []).map((d: any) => {
      const wh = d.energyWh ?? 0;
      const kwh = round2(wh / 1000);
      const gross = round2(d.gross ?? 0);
      const fee = round2(d.feeAmount ?? 0);
      return {
        date: d._id,
        sessionsCount: d.sessions,
        energyWh: wh,
        energyKwh: kwh,
        gross,
        fee,
        net: round2(gross - fee),
      };
    });

    // Format connector breakdown
    const connectors = (aggregateResult?.byConnector ?? []).map((c: any) => {
      const wh = c.energyWh ?? 0;
      const gross = round2(c.gross ?? 0);
      const fee = round2(c.feeAmount ?? 0);
      return {
        chargePointId: String(c._id.chargePointId),
        connectorId: c._id.connectorId,
        cpId: c.cpId,
        stationName: c.stationName ?? c.cpId,
        sessionsCount: c.sessions,
        energyKwh: round2(wh / 1000),
        gross,
        fee,
        net: round2(gross - fee),
      };
    });

    // Format recent sessions list with calculations
    const recentSessions = (aggregateResult?.recentSessions ?? []).map((tx: any) => {
      const wh = tx.energyWh ?? 0;
      const kwh = round2(wh / 1000);
      const cost = round2(tx.cost ?? 0);
      const feeAmount = round2(tx.feeAmount ?? 0);
      const net = round2(cost - feeAmount);
      return {
        id: tx._id,
        chargePointId: String(tx.chargePointId),
        cpId: tx.cpId,
        stationName: tx.stationName ?? tx.cpId,
        connectorId: tx.connectorId,
        idTag: tx.idTag,
        vehicleModel: tx.vehicleModel,
        startTimestamp: tx.startTimestamp,
        stopTimestamp: tx.stopTimestamp,
        energyWh: wh,
        energyKwh: kwh,
        tariffPerKwh: tx.tariffPerKwh,
        energyCost: round2(tx.energyCost ?? (cost - feeAmount)),
        feePercent: tx.feePercent,
        feeAmount,
        cost,
        clientNet: net,
      };
    });

    res.json({
      period: {
        from: q.from ?? null,
        to: q.to ?? null,
      },
      client: clientInfo
        ? {
            id: String(clientInfo._id),
            name: clientInfo.name,
            businessRegister: clientInfo.businessRegister,
            feePercent: clientInfo.feePercent,
            payoutAccount: clientInfo.payoutAccount,
          }
        : null,
      totals: {
        sessionsCount: totalSessions,
        energyWh: totalEnergyWh,
        energyKwh: totalEnergyKwh,
        gross: totalGross,
        fee: totalFee,
        net: totalNet,
        paidTotal,
        outstanding,
        lastPaidAt,
        averageSessionKwh: totalSessions > 0 ? round2(totalEnergyKwh / totalSessions) : 0,
        averageSessionCost: totalSessions > 0 ? round2(totalGross / totalSessions) : 0,
      },
      formulasGuide: {
        energy: 'Эрчим хүч (кВт.ц) = Тоолуурын заалт (Вт.ц) ÷ 1,000',
        gross: 'Борлуулалтын нийт дүн (₮) = Цэнэглэсэн кВт.ц × Тариф (хэрэглэгчийн төлөх дүн)',
        fee: 'Eplug үйлчилгээний шимтгэл (₮) = Нийт борлуулалт × Шимтгэлийн хувь (%)',
        energyCost: 'Харилцагчийн орлого (₮) = Нийт борлуулалт - Eplug шимтгэл',
        clientNet: 'Харилцагчид олгох цэвэр орлого (₮) = Нийт борлуулалт - Шимтгэл',
        outstanding: 'Шилжүүлэх үлдэгдэл тооцоо (₮) = Харилцагчийн нийт цэвэр орлого - Шилжүүлсэн төлөлт',
      },
      stations,
      daily,
      connectors,
      recentSessions,
    });
  }),
);

const sessionsExportSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  chargePointId: z.string().min(1),
});

/** Keep only the last 4 digits so station owners can tell drivers apart without seeing contacts. */
function maskPhone(phone?: string | null): string {
  if (!phone) return '';
  return phone.length <= 4 ? phone : `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`;
}

/**
 * GET /api/reports/sessions-export?chargePointId=&from=&to=
 * Every completed session of one station in the period (no 500-row cap), joined
 * with the driver account, the charge card and the payment that funded it.
 * Station-owner (CLIENT) accounts get driver contacts masked.
 */
reportsRouter.get(
  '/sessions-export',
  validate(sessionsExportSchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof sessionsExportSchema>;
    const isClientUser = req.user?.role === 'CLIENT' || Boolean(req.user?.clientId);

    const cp = await ChargePoint.findOne(
      isValidObjectId(q.chargePointId) ? { _id: q.chargePointId } : { cpId: q.chargePointId },
    ).lean();
    if (!cp) throw badRequest('Charge point not found');

    const match: Record<string, unknown> = { chargePointId: cp._id, status: 'Completed' };

    if (isClientUser) {
      const clientId = String(req.user?.clientId ?? '');
      const isOwner = String(cp.clientId ?? '') === clientId;
      const isLinked = (cp.linkedClientIds ?? []).some((cid) => String(cid) === clientId);
      if (!clientId || (!isOwner && !isLinked)) throw forbidden('Access denied for this station');
      // A linked (non-owner) client only sees the sessions billed to them.
      if (!isOwner) match.clientId = new Types.ObjectId(clientId);
    }

    const stop: Record<string, Date> = {};
    if (q.from) stop.$gte = q.from;
    if (q.to) stop.$lt = q.to;
    if (Object.keys(stop).length) match.stopTimestamp = stop;

    const txs = await Transaction.find(match).sort({ stopTimestamp: 1 }).lean();

    const tagIds = [...new Set(txs.map((t) => t.idTag).filter(Boolean))];
    const [tags, payments] = await Promise.all([
      IdTag.find({ _id: { $in: tagIds } }).lean(),
      Payment.find({ transactionId: { $in: txs.map((t) => t._id) } })
        .select('transactionId provider status paidAmount amount paidAt')
        .lean(),
    ]);

    const tagMap = new Map(tags.map((t) => [String(t._id), t]));
    const driverIds = tags
      .filter((t) => t.walletOwnerType === 'USER' && t.walletOwnerId && isValidObjectId(t.walletOwnerId))
      .map((t) => String(t.walletOwnerId));
    const drivers = await DriverUser.find({
      $or: [{ idTag: { $in: tagIds } }, { _id: { $in: driverIds } }],
    })
      .select('name phone email idTag vehicleBrand vehicleModel isInternal')
      .lean();
    const driverById = new Map(drivers.map((d) => [String(d._id), d]));
    const driverByTag = new Map(drivers.filter((d) => d.idTag).map((d) => [String(d.idTag), d]));

    const paymentByTx = new Map<number, (typeof payments)[number]>();
    for (const p of payments) {
      if (p.transactionId == null) continue;
      const prev = paymentByTx.get(p.transactionId);
      // A session can have several invoices; prefer the paid one.
      if (!prev || p.status === 'PAID') paymentByTx.set(p.transactionId, p);
    }

    const sessions = txs.map((t) => {
      const tag = tagMap.get(t.idTag);
      const driver =
        driverByTag.get(t.idTag) ??
        (tag?.walletOwnerType === 'USER' && tag.walletOwnerId
          ? driverById.get(String(tag.walletOwnerId))
          : undefined);
      const payment = paymentByTx.get(t._id);
      const energyKwh = round2((t.energyWh ?? 0) / 1000);
      const durationMin =
        t.stopTimestamp && t.startTimestamp
          ? Math.round((new Date(t.stopTimestamp).getTime() - new Date(t.startTimestamp).getTime()) / 60000)
          : null;
      const cost = round2(t.cost ?? 0);
      const fee = round2(t.feeAmount ?? 0);
      const phone = driver?.phone ?? tag?.ownerPhone ?? '';
      const email = driver?.email ?? tag?.ownerEmail ?? '';
      const vehicle =
        [driver?.vehicleBrand, driver?.vehicleModel].filter(Boolean).join(' ') || t.vehicleModel || '';

      return {
        id: t._id,
        connectorId: t.connectorId,
        idTag: t.idTag,
        driverName: driver?.name ?? tag?.ownerName ?? tag?.label ?? '',
        driverPhone: isClientUser ? maskPhone(phone) : phone,
        driverEmail: isClientUser ? '' : email,
        driverType: driver ? (driver.isInternal ? 'Дотоод' : 'Апп хэрэглэгч') : tag ? 'Карт' : 'Тодорхойгүй',
        vehicle,
        vehicleVin: isClientUser ? '' : (t.vehicleVin ?? ''),
        vehicleBatteryKwh: t.vehicleBatteryKwh ?? null,
        startTimestamp: t.startTimestamp,
        stopTimestamp: t.stopTimestamp ?? null,
        durationMin,
        meterStartWh: t.meterStart,
        meterStopWh: t.meterStop ?? null,
        energyKwh,
        avgPowerKw: durationMin && durationMin > 0 ? round2(energyKwh / (durationMin / 60)) : null,
        startSocPercent: t.startSocPercent ?? null,
        endSocPercent: t.lastSocPercent ?? null,
        tariffPerKwh: t.tariffPerKwh ?? null,
        energyCost: round2(t.energyCost ?? cost - fee),
        feePercent: t.feePercent ?? 0,
        feeAmount: fee,
        cost,
        clientNet: round2(cost - fee),
        stopReason: t.stopReason ?? '',
        startedRemotely: Boolean(t.startedRemotely),
        paymentProvider: payment?.provider ?? '',
        paymentStatus: payment?.status ?? '',
        paidAmount: payment ? round2(payment.paidAmount ?? 0) : null,
        ebarimtStatus: t.ebarimt?.status ?? '',
        ebarimtReceiptId: t.ebarimt?.receiptId ?? '',
        refundAmount: t.refund?.amount != null ? round2(t.refund.amount) : null,
        stationError: t.stationError?.errorCode ?? '',
      };
    });

    const totalWh = txs.reduce((a, t) => a + (t.energyWh ?? 0), 0);
    const gross = round2(sessions.reduce((a, s) => a + s.cost, 0));
    const fee = round2(sessions.reduce((a, s) => a + s.feeAmount, 0));

    res.json({
      station: {
        id: String(cp._id),
        cpId: cp.cpId,
        name: cp.name ?? cp.cpId,
        address: cp.address ?? '',
        vendor: cp.chargePointVendor ?? '',
        model: cp.chargePointModel ?? '',
        serialNumber: cp.chargePointSerialNumber ?? '',
        tariffPerKwh: cp.tariffPerKwh ?? null,
        tariffZones: cp.tariffZones ?? [],
      },
      period: { from: q.from ?? null, to: q.to ?? null },
      contactsMasked: isClientUser,
      totals: {
        sessionsCount: sessions.length,
        driversCount: new Set(sessions.map((s) => s.idTag)).size,
        energyKwh: round2(totalWh / 1000),
        gross,
        fee,
        net: round2(gross - fee),
      },
      sessions,
    });
  }),
);

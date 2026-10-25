import { Router } from 'express';
import { isValidObjectId, Types } from 'mongoose';
import { z } from 'zod';
import { badRequest, forbidden } from '../../lib/errors';
import { ChargePoint } from '../../models/ChargePoint';
import { Client } from '../../models/Client';
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
    if (req.user?.role === 'CLIENT') {
      if (!req.user.clientId) throw forbidden('Client ID not found in session');
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
    if (q.to) stop.$lt = q.to;
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
      pipeline.push({
        $match: { effectiveClientId: new Types.ObjectId(targetClientId) },
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

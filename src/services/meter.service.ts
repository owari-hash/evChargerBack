import type { Types } from 'mongoose';
import { MeterValue } from '../models/MeterValue';
import { Transaction } from '../models/Transaction';
import { Connector } from '../models/Connector';
import { bus } from '../realtime/events';
import type { MeterValueEntry } from '../ocpp/schemas/common';

const ENERGY_MEASURANDS = new Set([
  'Energy.Active.Import.Register',
  'Energy.Active.Import.Interval',
]);

function toWh(value: number, unit?: string): number {
  return unit === 'kWh' ? value * 1000 : value;
}

function toW(value: number, unit?: string): number {
  return unit === 'kW' ? value * 1000 : value;
}

interface Extracted {
  energyWh?: number;
  powerW?: number;
  socPercent?: number;
}

function extract(entry: MeterValueEntry): Extracted {
  const out: Extracted = {};
  for (const sv of entry.sampledValue) {
    const num = Number(sv.value);
    if (!Number.isFinite(num)) continue;
    const measurand = sv.measurand ?? 'Energy.Active.Import.Register';

    if (ENERGY_MEASURANDS.has(measurand) && out.energyWh === undefined) {
      out.energyWh = toWh(num, sv.unit);
    } else if (measurand === 'Power.Active.Import' && out.powerW === undefined) {
      out.powerW = toW(num, sv.unit);
    } else if (measurand === 'SoC' && out.socPercent === undefined) {
      out.socPercent = num;
    }
  }
  return out;
}

/**
 * Persist a batch of MeterValue entries and roll the latest readings up onto
 * the transaction and connector documents for cheap dashboard queries.
 */
export async function storeMeterValues(
  chargePointId: Types.ObjectId,
  cpId: string,
  connectorId: number,
  transactionId: number | undefined,
  entries: MeterValueEntry[],
): Promise<void> {
  if (entries.length === 0) return;

  const docs = entries.map((entry) => ({
    chargePointId,
    connectorId,
    transactionId: transactionId ?? null,
    timestamp: entry.timestamp,
    sampledValue: entry.sampledValue.map((sv) => ({
      ...sv,
      numericValue: Number.isFinite(Number(sv.value)) ? Number(sv.value) : undefined,
    })),
  }));

  await MeterValue.insertMany(docs, { ordered: false });

  // Use the newest entry for the denormalised rollups.
  const latest = entries.reduce((a, b) => (a.timestamp > b.timestamp ? a : b));
  const { energyWh, powerW, socPercent } = extract(latest);

  const connectorUpdate: Record<string, unknown> = {};
  if (energyWh !== undefined) connectorUpdate.lastMeterWh = energyWh;
  if (powerW !== undefined) connectorUpdate.lastPowerW = powerW;
  if (socPercent !== undefined) connectorUpdate.lastSocPercent = socPercent;

  if (Object.keys(connectorUpdate).length > 0) {
    await Connector.updateOne(
      { chargePointId, connectorId },
      { $set: connectorUpdate },
      { upsert: false },
    ).catch(() => undefined);
  }

  if (transactionId !== undefined) {
    const tx = await Transaction.findById(transactionId);
    if (tx && tx.status === 'Active') {
      if (energyWh !== undefined) {
        tx.lastMeterWh = energyWh;
        tx.energyWh = Math.max(0, Math.round(energyWh - tx.meterStart));
      }
      if (powerW !== undefined) tx.lastPowerW = powerW;
      if (socPercent !== undefined) tx.lastSocPercent = socPercent;
      tx.lastMeterValueAt = latest.timestamp;
      await tx.save();
    }
  }

  bus.emitEvent('transaction.metervalue', cpId, {
    connectorId,
    transactionId: transactionId ?? null,
    timestamp: latest.timestamp,
    energyWh,
    powerW,
    socPercent,
    sampledValue: latest.sampledValue,
  });
}

import type { Types } from 'mongoose';
import { MeterValue } from '../models/MeterValue';
import { Transaction } from '../models/Transaction';
import { Connector } from '../models/Connector';
import { bus } from '../realtime/events';
import type { MeterValueEntry } from '../ocpp/schemas/common';

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

const PHASES = ['L1', 'L2', 'L3'];

/**
 * The station total for one measurand. Stations often list per-phase values
 * (L1/L2/L3, L1-N…) next to — or before — the total, so a value with a phase
 * is never taken as the total. Without a total, the three phases are summed.
 */
function total(
  values: MeterValueEntry['sampledValue'],
  measurand: string,
  convert: (value: number, unit?: string) => number,
): number | undefined {
  const matching = values.filter(
    (sv) => (sv.measurand ?? 'Energy.Active.Import.Register') === measurand && Number.isFinite(Number(sv.value)),
  );
  const whole = matching.find((sv) => !sv.phase);
  if (whole) return convert(Number(whole.value), whole.unit);
  const perPhase = PHASES.map((p) => matching.find((sv) => sv.phase === p || sv.phase === `${p}-N`));
  if (perPhase.every(Boolean)) {
    return perPhase.reduce((sum, sv) => sum + convert(Number(sv!.value), sv!.unit), 0);
  }
  return undefined;
}

function extract(entry: MeterValueEntry): Extracted {
  return {
    // Only the cumulative register says where the meter stands; an Interval
    // sample is a delta and would rewind the session's energy.
    energyWh: total(entry.sampledValue, 'Energy.Active.Import.Register', toWh),
    powerW: total(entry.sampledValue, 'Power.Active.Import', toW),
    socPercent: entry.sampledValue
      .filter((sv) => sv.measurand === 'SoC' && Number.isFinite(Number(sv.value)))
      .map((sv) => Number(sv.value))[0],
  };
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

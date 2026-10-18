import type { Types } from 'mongoose';
import { MeterValue } from '../models/MeterValue';
import { Transaction } from '../models/Transaction';
import { Connector } from '../models/Connector';
import { bus } from '../realtime/events';
import type { MeterValueEntry } from '../ocpp/schemas/common';
import { applySessionCost } from './pricing.service';
import { env } from '../config/env';
import { ocppLogger } from '../lib/logger';
import { connectionManager } from '../ocpp/manager';
import { resolveWalletOwnerForIdTag, balanceOf } from './wallet.service';

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
const lastRemoteStopAttempts = new Map<number, number>();

/**
 * The station total for one measurand. Stations often list per-phase values
 * (L1/L2/L3, L1-N…) next to — or before — the total, so a value with a phase
 * is never taken as the total. Without a total, the three phases are summed.
 * For single-phase chargers or simulators reporting only L1, the reported phase is used.
 */
function total(
  values: MeterValueEntry['sampledValue'],
  measurand: string,
  convert: (value: number, unit?: string) => number,
): number | undefined {
  const matching = values.filter(
    (sv) => (sv.measurand ?? 'Energy.Active.Import.Register') === measurand && Number.isFinite(Number(sv.value)),
  );
  if (matching.length === 0) return undefined;

  const whole = matching.find((sv) => !sv.phase);
  if (whole) return convert(Number(whole.value), whole.unit);

  const perPhase = PHASES.map((p) => matching.find((sv) => sv.phase === p || sv.phase === `${p}-N`));
  if (perPhase.every(Boolean)) {
    return perPhase.reduce((sum, sv) => sum + convert(Number(sv!.value), sv!.unit), 0);
  }

  // Single-phase fallback (e.g. only L1 provided by simulator or 1-phase AC station)
  const present = matching.filter((sv) => sv.phase);
  if (present.length > 0) {
    return present.reduce((sum, sv) => sum + convert(Number(sv.value), sv.unit), 0);
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

  let tx =
    transactionId !== undefined && transactionId > 0
      ? await Transaction.findById(transactionId)
      : null;
  if (!tx && connectorId > 0) {
    tx = await Transaction.findOne({ chargePointId, connectorId, status: 'Active' });
  }
  if (tx && tx.status === 'Active') {
      const prevMeterWh = tx.lastMeterWh ?? tx.meterStart;
      const prevTime = tx.lastMeterValueAt;
      if (energyWh !== undefined) {
        tx.lastMeterWh = energyWh;
        tx.energyWh = Math.max(0, Math.round(energyWh - tx.meterStart));
        applySessionCost(tx);
      }
      if (powerW !== undefined) {
        tx.lastPowerW = powerW;
      } else if (energyWh !== undefined && prevTime) {
        const dtSeconds =
          (new Date(latest.timestamp).getTime() - new Date(prevTime).getTime()) / 1000;
        if (dtSeconds > 0 && dtSeconds <= 120) {
          const deltaWh = energyWh - prevMeterWh;
          if (deltaWh >= 0) {
            tx.lastPowerW = Math.round((deltaWh / dtSeconds) * 3600);
          }
        }
      }
      if (socPercent !== undefined) tx.lastSocPercent = socPercent;
      tx.lastMeterValueAt = latest.timestamp;
      await tx.save();

      // Check driver wallet balance to preemptively stop session before running into negative balance/debt
      if (
        env.WALLET_ENABLED &&
        typeof tx.cost === 'number' &&
        tx.cost > 0
      ) {
        try {
          const owner = await resolveWalletOwnerForIdTag(tx.idTag);
          // CLIENT ownerType represents internal/fleet cards that charge without prepaid balance cut-off
          if (owner && owner.ownerType !== 'CLIENT') {
            const balance = await balanceOf(owner);
            // If cost has reached or is about to exceed available balance (margin: 50 MNT)
            if (tx.cost >= balance - 50) {
              const now = Date.now();
              const lastAttempt = lastRemoteStopAttempts.get(tx._id) ?? 0;
              if (now - lastAttempt > 4000) {
                lastRemoteStopAttempts.set(tx._id, now);
                ocppLogger.warn(
                  {
                    txId: tx._id,
                    cpId,
                    idTag: tx.idTag,
                    cost: tx.cost,
                    balance,
                  },
                  'Driver wallet balance exhausted; issuing RemoteStopTransaction to prevent negative balance',
                );
                tx.stoppedRemotely = true;
                await tx.save();

                connectionManager
                  .send<{ status: string }>(
                    cpId,
                    'RemoteStopTransaction',
                    { transactionId: tx._id },
                    'balance-enforcer',
                  )
                  .catch((err) => {
                    ocppLogger.error(
                      { err: (err as Error).message, txId: tx._id, cpId },
                      'Failed to send RemoteStopTransaction for exhausted balance',
                    );
                  });
              }
            }
          }
        } catch (err) {
          ocppLogger.error(
            { err: (err as Error).message, txId: tx._id },
            'Failed checking balance exhaustion during meter values update',
          );
        }
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

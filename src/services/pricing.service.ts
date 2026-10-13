import type { Types } from 'mongoose';
import { env } from '../config/env';
import { Client } from '../models/Client';

/**
 * Session pricing. The driver pays the energy at the station's tariff plus
 * Eplug's service fee on top of it: 1,000₮ of energy at 5% costs 1,050₮.
 */

const money = (n: number) => Number(n.toFixed(4));

interface FeeSource {
  feePercent?: number | null;
}

/** Station setting, else its client's, else the network default. */
export function resolveFeePercent(station: FeeSource | null | undefined, client: FeeSource | null | undefined): number {
  if (typeof station?.feePercent === 'number') return station.feePercent;
  if (typeof client?.feePercent === 'number') return client.feePercent;
  return env.PLATFORM_FEE_PERCENT;
}

/** The same, loading the station's client. */
export async function feePercentForStation(station: {
  feePercent?: number | null;
  clientId?: Types.ObjectId | null;
}): Promise<number> {
  if (typeof station.feePercent === 'number') return station.feePercent;
  const client = station.clientId
    ? await Client.findById(station.clientId).select('feePercent').lean()
    : null;
  return resolveFeePercent(null, client);
}

/** What a driver pays per kWh at a station, fee included. */
export function driverTariff(tariffPerKwh: number | null | undefined, feePercent: number): number | undefined {
  if (typeof tariffPerKwh !== 'number') return undefined;
  return money(tariffPerKwh * (1 + feePercent / 100));
}

export interface SessionCost {
  energyCost: number;
  feeAmount: number;
  cost: number;
}

/**
 * Null when the station has no tariff: the session is not priced. Amounts are
 * whole tugriks, so the session cost, the wallet debit, the receipt and the
 * client's earnings are all the same number.
 */
export function sessionCost(
  energyWh: number,
  tariffPerKwh: number | null | undefined,
  feePercent: number | null | undefined,
): SessionCost | null {
  if (!tariffPerKwh) return null;
  const energyCost = Math.round((energyWh / 1000) * tariffPerKwh);
  const feeAmount = Math.round((energyCost * (feePercent ?? 0)) / 100);
  return { energyCost, feeAmount, cost: energyCost + feeAmount };
}

/** Write energyCost / feeAmount / cost onto a transaction from its energy. */
export function applySessionCost(tx: {
  energyWh?: number | null;
  tariffPerKwh?: number | null;
  feePercent?: number | null;
  energyCost?: number | null;
  feeAmount?: number | null;
  cost?: number | null;
}): void {
  const priced = sessionCost(tx.energyWh ?? 0, tx.tariffPerKwh, tx.feePercent);
  if (!priced) return;
  tx.energyCost = priced.energyCost;
  tx.feeAmount = priced.feeAmount;
  tx.cost = priced.cost;
}

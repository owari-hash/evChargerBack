import type { Types } from 'mongoose';
import { env } from '../config/env';
import { Client } from '../models/Client';

/**
 * Session pricing. The driver pays the energy at the station's tariff plus
 * Eplug's service fee on top of it: 1,000₮ of energy at 5% costs 1,050₮.
 *
 * A station's tariff can also vary by time of day (`TariffZone`); a session
 * that spans a zone boundary is billed as if it were several back-to-back
 * sessions, one per zone, weighted by how long it actually ran in each —
 * not by how much energy landed on which side, which OCPP's meter values are
 * not reported often enough to attribute precisely anyway.
 */

const money = (n: number) => Number(n.toFixed(4));

/** Mongolia runs one fixed offset year-round — no DST to account for. */
const MN_OFFSET_MINUTES = 8 * 60;
const DAY_MS = 24 * 60 * 60_000;

export interface TariffZone {
  /** Minutes since local midnight, inclusive. */
  startMinute: number;
  /** Minutes since local midnight, exclusive. Always > startMinute — a zone
   *  spanning midnight is two entries, not one that wraps. */
  endMinute: number;
  tariffPerKwh: number;
}

/** Rejects any zone set that is malformed or has two zones covering the same minute. */
export function validateTariffZones(zones: TariffZone[]): string | null {
  for (const z of zones) {
    if (!(z.startMinute >= 0 && z.startMinute < 1440)) return 'Эхлэх цаг буруу байна';
    if (!(z.endMinute > z.startMinute && z.endMinute <= 1440)) {
      return 'Дуусах цаг эхлэх цагаас хойш байх ёстой (нэг өдрийн дотор)';
    }
    if (!(z.tariffPerKwh >= 0)) return 'Тариф сөрөг байж болохгүй';
  }
  const sorted = [...zones].sort((a, b) => a.startMinute - b.startMinute);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startMinute < sorted[i - 1].endMinute) {
      return 'Цагийн бүсүүд давхцаж болохгүй';
    }
  }
  return null;
}

function minuteOfDay(date: Date): number {
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return (utcMinutes + MN_OFFSET_MINUTES) % 1440;
}

/** The UTC instant of local (Mongolia) midnight on the local day `date` falls on. */
function localMidnightUtc(date: Date): Date {
  const shifted = new Date(date.getTime() + MN_OFFSET_MINUTES * 60_000);
  const localMidnightShifted = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(localMidnightShifted - MN_OFFSET_MINUTES * 60_000);
}

/** The zone covering `at`, or `fallback` (the station's flat rate) outside all of them. */
export function tariffZoneAt(
  zones: TariffZone[] | null | undefined,
  at: Date,
  fallback: number | null | undefined,
): number | undefined {
  const minute = minuteOfDay(at);
  const zone = (zones ?? []).find((z) => minute >= z.startMinute && minute < z.endMinute);
  return zone ? zone.tariffPerKwh : (fallback ?? undefined);
}

/** What a station is charging right now — this is what kiosk/app display, so
 *  it changes on its own the moment a zone boundary passes; nothing pushes it. */
export function currentStationTariff(
  station: { tariffPerKwh?: number | null; tariffZones?: TariffZone[] | null },
  at: Date = new Date(),
): number | undefined {
  return tariffZoneAt(station.tariffZones, at, station.tariffPerKwh);
}

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

/**
 * Every instant where the applicable zone could change between `start` and
 * `stop`: each zone's own start/end, projected onto every local day the
 * session touches, plus the session's own endpoints. The segments between
 * consecutive boundaries are each priced by a single zone.
 */
function tariffBoundaries(start: Date, stop: Date, zones: TariffZone[]): number[] {
  const boundaries = new Set<number>([start.getTime(), stop.getTime()]);
  let day = localMidnightUtc(start);
  while (day.getTime() < stop.getTime()) {
    for (const zone of zones) {
      for (const minute of [zone.startMinute, zone.endMinute]) {
        const instant = day.getTime() + minute * 60_000;
        if (instant > start.getTime() && instant < stop.getTime()) boundaries.add(instant);
      }
    }
    day = new Date(day.getTime() + DAY_MS);
  }
  return [...boundaries].sort((a, b) => a - b);
}

/**
 * Prices a session across however many zones it ran through, weighting each
 * zone's rate by the fraction of the session's real duration spent in it —
 * a session half in a 400₮ zone and half in a 600₮ zone bills at 500₮/kWh
 * blended, regardless of how the energy itself was distributed between the
 * two halves. Null if the session has no duration or no rate anywhere in it.
 */
export function sessionCostTimeWeighted(
  energyWh: number,
  start: Date,
  stop: Date,
  zones: TariffZone[] | null | undefined,
  fallbackTariffPerKwh: number | null | undefined,
  feePercent: number | null | undefined,
): (SessionCost & { tariffPerKwh: number }) | null {
  const totalMs = stop.getTime() - start.getTime();
  if (totalMs <= 0) return null;
  if (!zones?.length) {
    const flat = sessionCost(energyWh, fallbackTariffPerKwh, feePercent);
    return flat && typeof fallbackTariffPerKwh === 'number' ? { ...flat, tariffPerKwh: fallbackTariffPerKwh } : null;
  }

  const boundaries = tariffBoundaries(start, stop, zones);
  let weightedRateMs = 0;
  for (let i = 0; i < boundaries.length - 1; i++) {
    const segStart = boundaries[i];
    const segEnd = boundaries[i + 1];
    const duration = segEnd - segStart;
    if (duration <= 0) continue;
    const midpoint = new Date((segStart + segEnd) / 2);
    const rate = tariffZoneAt(zones, midpoint, fallbackTariffPerKwh) ?? 0;
    weightedRateMs += rate * duration;
  }
  const effectiveTariff = weightedRateMs / totalMs;
  if (!effectiveTariff) return null;

  const energyCost = Math.round((energyWh / 1000) * effectiveTariff);
  const feeAmount = Math.round((energyCost * (feePercent ?? 0)) / 100);
  return { energyCost, feeAmount, cost: energyCost + feeAmount, tariffPerKwh: money(effectiveTariff) };
}

/** Write energyCost / feeAmount / cost onto a transaction from its energy —
 *  time-weighted across `tariffZones` when the session has both zones and a
 *  start/stop to weigh them by, otherwise the flat single-rate calculation. */
export function applySessionCost(tx: {
  energyWh?: number | null;
  tariffPerKwh?: number | null;
  tariffZones?: TariffZone[] | null;
  startTimestamp?: Date | null;
  stopTimestamp?: Date | null;
  feePercent?: number | null;
  energyCost?: number | null;
  feeAmount?: number | null;
  cost?: number | null;
}): void {
  // A still-active session (no stopTimestamp yet) is priced as of now — an
  // estimate that moves with the clock, so a driver watching a live session
  // straddle a zone boundary sees the same number the final bill will land
  // on, rather than a surprise once they actually stop.
  const priced =
    tx.tariffZones?.length && tx.startTimestamp
      ? sessionCostTimeWeighted(
          tx.energyWh ?? 0,
          tx.startTimestamp,
          tx.stopTimestamp ?? new Date(),
          tx.tariffZones,
          tx.tariffPerKwh,
          tx.feePercent,
        )
      : sessionCost(tx.energyWh ?? 0, tx.tariffPerKwh, tx.feePercent);
  if (!priced) return;
  tx.energyCost = priced.energyCost;
  tx.feeAmount = priced.feeAmount;
  tx.cost = priced.cost;
  // The blended rate this session actually billed at — the flat path leaves
  // tariffPerKwh exactly as it already was, since there is only one rate.
  if ('tariffPerKwh' in priced) tx.tariffPerKwh = priced.tariffPerKwh;
}

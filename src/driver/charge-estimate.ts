import { MeterValue } from '../models/MeterValue';

/**
 * "≈ 27 мин дүүрэхэд" — how long until the battery is full, estimated from
 * how fast the station-reported battery % has been rising.
 *
 * Only stations that report SoC in MeterValues (DC chargers, as a rule) can
 * be estimated; for the rest this returns undefined and nothing is shown.
 */

/** How far back the charging speed is measured. */
const WINDOW_MS = 10 * 60_000;
/** Below this much rise the speed is too noisy to promise a time from. */
const MIN_RISE_PERCENT = 2;
const MIN_SPAN_MS = 2 * 60_000;
/**
 * Above 80 % a DC charger slows down sharply to protect the battery. When the
 * speed was measured below that, the last stretch is assumed to take this
 * many times longer per percent.
 */
const TAPER_FROM = 80;
const TAPER_SLOWDOWN = 2.5;
/** Anything longer is not a useful thing to tell a driver at a charger. */
const MAX_MINUTES = 12 * 60;

export interface SocSample {
  at: number;
  soc: number;
}

/**
 * Pure part, for tests: minutes from the latest sample to 100 %, or
 * undefined when the samples cannot support an estimate.
 */
export function minutesToFullFrom(samples: SocSample[]): number | undefined {
  if (samples.length < 2) return undefined;
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  const last = sorted[sorted.length - 1]!;
  if (last.soc >= 100) return 0;

  // Measure over the recent window; fall back to the whole session when the
  // window alone has not seen enough rise yet (early on, or a slow AC car).
  const recent = sorted.filter((s) => s.at >= last.at - WINDOW_MS);
  const pick = (from: SocSample[]) => {
    const first = from[0]!;
    const rise = last.soc - first.soc;
    const span = last.at - first.at;
    return rise >= MIN_RISE_PERCENT && span >= MIN_SPAN_MS ? rise / (span / 60_000) : undefined;
  };
  const perMinute = pick(recent) ?? pick(sorted);
  if (!perMinute || perMinute <= 0) return undefined;

  let minutes: number;
  if (last.soc < TAPER_FROM) {
    minutes =
      (TAPER_FROM - last.soc) / perMinute + (100 - TAPER_FROM) / (perMinute / TAPER_SLOWDOWN);
  } else {
    // Already in the slow stretch: the measured speed is the slow speed.
    minutes = (100 - last.soc) / perMinute;
  }
  if (!Number.isFinite(minutes) || minutes > MAX_MINUTES) return undefined;
  return Math.max(1, Math.round(minutes));
}

/** Reads a running transaction's SoC history and estimates time to full. */
export async function estimateMinutesToFull(transactionId: number): Promise<number | undefined> {
  const rows = await MeterValue.find({
    transactionId,
    'sampledValue.measurand': 'SoC',
  })
    .sort({ timestamp: -1 })
    .limit(240)
    .select('timestamp sampledValue')
    .lean<{ timestamp: Date; sampledValue: { measurand?: string; value: string }[] }[]>();

  const samples: SocSample[] = [];
  for (const row of rows) {
    const sv = row.sampledValue.find((v) => v.measurand === 'SoC');
    const soc = Number(sv?.value);
    if (Number.isFinite(soc)) samples.push({ at: new Date(row.timestamp).getTime(), soc });
  }
  return minutesToFullFrom(samples);
}

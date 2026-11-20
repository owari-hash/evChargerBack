import { Types } from 'mongoose';
import { ChargePoint } from '../models/ChargePoint';
import { Connector } from '../models/Connector';
import { MeterValue } from '../models/MeterValue';

/**
 * Per-station power statistics built from OCPP MeterValues.
 *
 * Every connector's samples are laid on a one-minute grid (a sample's value is
 * held until the next one, at most HOLD_MS), so the station total, the number
 * of guns charging at once and how they split the power can be read minute by
 * minute.
 */

const STEP_MS = 60_000;
const HOLD_MS = 150_000; // a sample keeps counting for up to 2.5 min
const MAX_DERIVE_GAP_MS = 10 * 60_000;
const CHARGING_KW = 1; // below this a gun counts as idle
const MAX_RANGE_DAYS = 31;
const MAX_SERIES_POINTS = 480;
export const UB_OFFSET_MIN = 480; // Asia/Ulaanbaatar, UTC+8, no DST

export interface PowerSample {
  connectorId: number;
  ts: number; // epoch ms
  powerW?: number;
  energyWh?: number;
  transactionId?: number | null;
  end?: boolean; // Transaction.End reading: the gun stops here
}

interface Agg {
  minutes: number; // minutes with ≥1 gun charging
  sumKw: number;
  peakKw: number;
  peakAt: number | null;
  activeKw: number[]; // totals while charging (for the low percentile)
  energyKwh: number;
  simultaneousMinutes: number;
  sessions: Set<number>;
}

function newAgg(): Agg {
  return {
    minutes: 0,
    sumKw: 0,
    peakKw: 0,
    peakAt: null,
    activeKw: [],
    energyKwh: 0,
    simultaneousMinutes: 0,
    sessions: new Set(),
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
}

function finishAgg(a: Agg) {
  return {
    chargingMinutes: a.minutes,
    avgKw: a.minutes ? r1(a.sumKw / a.minutes) : 0,
    peakKw: r1(a.peakKw),
    peakAt: a.peakAt ? new Date(a.peakAt).toISOString() : null,
    // The lowest steady load while charging. The bottom 5% is skipped so the
    // ramp-up and the last taper minute of each session don't read as "low".
    lowKw: r1(percentile(a.activeKw, 0.05)),
    energyKwh: r1(a.energyKwh),
    simultaneousMinutes: a.simultaneousMinutes,
    sessions: a.sessions.size,
  };
}

export function localDayKey(ts: number, offsetMin = UB_OFFSET_MIN): string {
  return new Date(ts + offsetMin * 60_000).toISOString().slice(0, 10);
}

/** Pure computation, exported for tests. */
export function computeStationPowerStats(
  samples: PowerSample[],
  opts: { from: number; to: number; connectorIds?: number[]; offsetMin?: number },
) {
  const offsetMin = opts.offsetMin ?? UB_OFFSET_MIN;
  const from = Math.floor(opts.from / STEP_MS) * STEP_MS;
  const to = opts.to;
  const steps = Math.max(0, Math.ceil((to - from) / STEP_MS));

  const ids = Array.from(
    new Set([...(opts.connectorIds ?? []), ...samples.map((s) => s.connectorId)]),
  ).filter((c) => c > 0).sort((a, b) => a - b);

  // ---- 1. kW per connector per minute --------------------------------------
  const grid = new Map<number, Float64Array>();
  const txAt = new Map<number, (number | null)[]>();
  for (const cid of ids) {
    const rows = samples
      .filter((s) => s.connectorId === cid)
      .sort((a, b) => a.ts - b.ts);

    // Power for each sample: the reported value, or the slope of the energy
    // register when the charger doesn't report power.
    const pts: { ts: number; kw: number; tx: number | null; end: boolean }[] = [];
    let prev: PowerSample | undefined;
    for (const s of rows) {
      let kw: number | undefined;
      if (s.end) kw = 0;
      else if (s.powerW !== undefined && Number.isFinite(s.powerW)) kw = Math.max(0, s.powerW / 1000);
      else if (
        prev && s.energyWh !== undefined && prev.energyWh !== undefined &&
        prev.transactionId === s.transactionId && s.ts > prev.ts && s.ts - prev.ts <= MAX_DERIVE_GAP_MS
      ) {
        kw = Math.max(0, ((s.energyWh - prev.energyWh) / ((s.ts - prev.ts) / 3_600_000)) / 1000);
      }
      if (kw !== undefined) pts.push({ ts: s.ts, kw, tx: s.transactionId ?? null, end: Boolean(s.end) });
      prev = s;
    }

    const arr = new Float64Array(steps);
    const txs: (number | null)[] = new Array(steps).fill(null);
    let i = 0;
    let last: (typeof pts)[number] | undefined;
    for (let k = 0; k < steps; k++) {
      const start = from + k * STEP_MS;
      const end = start + STEP_MS;
      let sum = 0;
      let n = 0;
      while (i < pts.length && pts[i].ts < end) {
        if (pts[i].ts >= start) {
          sum += pts[i].kw;
          n++;
        }
        last = pts[i];
        i++;
      }
      if (n > 0) {
        arr[k] = sum / n;
        txs[k] = last?.tx ?? null;
      } else if (last && !last.end && start - last.ts <= HOLD_MS) {
        arr[k] = last.kw;
        txs[k] = last.tx;
      }
    }
    grid.set(cid, arr);
    txAt.set(cid, txs);
  }

  // ---- 2. Roll minutes up ----------------------------------------------------
  const overall = newAgg();
  const days = new Map<string, Agg>();
  const perConn = new Map<number, {
    agg: Agg;
    soloSum: number; soloMin: number; soloPeak: number;
    sharedSum: number; sharedMin: number; sharedPeak: number;
  }>();
  for (const cid of ids) {
    perConn.set(cid, { agg: newAgg(), soloSum: 0, soloMin: 0, soloPeak: 0, sharedSum: 0, sharedMin: 0, sharedPeak: 0 });
  }
  const hourly = Array.from({ length: 24 }, () => ({ sumKw: 0, minutes: 0, peakKw: 0 }));
  const splits = new Map<string, { minutes: number; kw: number[]; conns: number[] }>();
  let sharedTotalSum = 0;
  let sharedTotalPeak = 0;
  let sharedMinutes = 0;
  let maxSimultaneous = 0;

  const bucketMin = Math.max(1, Math.ceil(steps / MAX_SERIES_POINTS));
  const series: { t: string; totalKw: number; peakKw: number; piles: Record<string, number> }[] = [];
  let bSum: Record<number, number> = {};
  let bTotal = 0;
  let bPeak = 0;
  let bN = 0;

  for (let k = 0; k < steps; k++) {
    const ts = from + k * STEP_MS;
    let total = 0;
    const active: number[] = [];
    for (const cid of ids) {
      const kw = grid.get(cid)![k];
      total += kw;
      if (kw >= CHARGING_KW) active.push(cid);
    }

    const hour = new Date(ts + offsetMin * 60_000).getUTCHours();
    hourly[hour].sumKw += total;
    hourly[hour].minutes++;
    hourly[hour].peakKw = Math.max(hourly[hour].peakKw, total);

    if (active.length > 0) {
      const day = localDayKey(ts, offsetMin);
      if (!days.has(day)) days.set(day, newAgg());
      for (const agg of [overall, days.get(day)!]) {
        agg.minutes++;
        agg.sumKw += total;
        agg.activeKw.push(total);
        agg.energyKwh += total / 60;
        if (total > agg.peakKw) {
          agg.peakKw = total;
          agg.peakAt = ts;
        }
        if (active.length >= 2) agg.simultaneousMinutes++;
        for (const cid of active) {
          const tx = txAt.get(cid)![k];
          if (tx !== null) agg.sessions.add(tx);
        }
      }
      maxSimultaneous = Math.max(maxSimultaneous, active.length);

      for (const cid of active) {
        const kw = grid.get(cid)![k];
        const pc = perConn.get(cid)!;
        pc.agg.minutes++;
        pc.agg.sumKw += kw;
        pc.agg.activeKw.push(kw);
        pc.agg.energyKwh += kw / 60;
        if (kw > pc.agg.peakKw) {
          pc.agg.peakKw = kw;
          pc.agg.peakAt = ts;
        }
        const tx = txAt.get(cid)![k];
        if (tx !== null) pc.agg.sessions.add(tx);
        if (active.length === 1) {
          pc.soloSum += kw; pc.soloMin++; pc.soloPeak = Math.max(pc.soloPeak, kw);
        } else {
          pc.sharedSum += kw; pc.sharedMin++; pc.sharedPeak = Math.max(pc.sharedPeak, kw);
        }
      }

      if (active.length >= 2) {
        sharedMinutes++;
        sharedTotalSum += total;
        sharedTotalPeak = Math.max(sharedTotalPeak, total);
        // How the guns split the power, rounded to 5 kW, e.g. "30 + 30".
        const parts = active.map((cid) => Math.round(grid.get(cid)![k] / 5) * 5);
        const key = active.map((cid, j) => `${cid}:${parts[j]}`).join('|');
        const s = splits.get(key) ?? { minutes: 0, kw: parts, conns: active };
        s.minutes++;
        splits.set(key, s);
      }
    }

    // chart series
    for (const cid of ids) bSum[cid] = (bSum[cid] ?? 0) + grid.get(cid)![k];
    bTotal += total;
    bPeak = Math.max(bPeak, total);
    bN++;
    if (bN === bucketMin || k === steps - 1) {
      const piles: Record<string, number> = {};
      for (const cid of ids) piles[String(cid)] = r1(bSum[cid] / bN);
      series.push({ t: new Date(ts - (bN - 1) * STEP_MS).toISOString(), totalKw: r1(bTotal / bN), peakKw: r1(bPeak), piles });
      bSum = {}; bTotal = 0; bPeak = 0; bN = 0;
    }
  }

  const splitList = Array.from(splits.values())
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 8)
    .map((s) => {
      const conns = s.conns;
      return {
        minutes: s.minutes,
        pct: sharedMinutes ? r1((s.minutes / sharedMinutes) * 100) : 0,
        piles: conns.map((connectorId, j) => ({ connectorId, kw: s.kw[j] })),
        totalKw: s.kw.reduce((a, b) => a + b, 0),
      };
    });

  return {
    bucketMinutes: bucketMin,
    summary: { ...finishAgg(overall), maxSimultaneous },
    days: Array.from(days.entries())
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([date, agg]) => ({ date, ...finishAgg(agg) })),
    connectors: ids.map((cid) => {
      const pc = perConn.get(cid)!;
      return {
        connectorId: cid,
        ...finishAgg(pc.agg),
        soloAvgKw: pc.soloMin ? r1(pc.soloSum / pc.soloMin) : null,
        soloPeakKw: pc.soloMin ? r1(pc.soloPeak) : null,
        soloMinutes: pc.soloMin,
        sharedAvgKw: pc.sharedMin ? r1(pc.sharedSum / pc.sharedMin) : null,
        sharedPeakKw: pc.sharedMin ? r1(pc.sharedPeak) : null,
        sharedMinutes: pc.sharedMin,
      };
    }),
    sharing: {
      minutes: sharedMinutes,
      avgTotalKw: sharedMinutes ? r1(sharedTotalSum / sharedMinutes) : null,
      peakTotalKw: sharedMinutes ? r1(sharedTotalPeak) : null,
      splits: splitList,
    },
    hourly: hourly.map((h, hour) => ({
      hour,
      avgKw: h.minutes ? r1(h.sumKw / h.minutes) : 0,
      peakKw: r1(h.peakKw),
    })),
    series,
  };
}

// ---------------------------------------------------------------------------
// DB wrapper
// ---------------------------------------------------------------------------

type SV = { measurand?: string | null; phase?: string | null; unit?: string | null; context?: string | null; value?: string; numericValue?: number | null };

function num(sv: SV): number {
  return Number.isFinite(sv.numericValue as number) ? Number(sv.numericValue) : Number(sv.value);
}

/** Station total for a measurand; same phase rules as meter.service. */
function totalOf(values: SV[], measurand: string, kiloUnit: string): number | undefined {
  const m = values.filter((sv) => (sv.measurand ?? 'Energy.Active.Import.Register') === measurand && Number.isFinite(num(sv)));
  if (m.length === 0) return undefined;
  const conv = (sv: SV) => (sv.unit === kiloUnit ? num(sv) * 1000 : num(sv));
  const whole = m.find((sv) => !sv.phase);
  if (whole) return conv(whole);
  const phases = ['L1', 'L2', 'L3'].map((p) => m.find((sv) => sv.phase === p || sv.phase === `${p}-N`));
  if (phases.every(Boolean)) return phases.reduce((s, sv) => s + conv(sv!), 0);
  return m.filter((sv) => sv.phase).reduce((s, sv) => s + conv(sv), 0);
}

export class StatsRangeError extends Error {}

export async function getStationPowerStats(params: {
  stationRef: string;
  from: Date;
  to: Date;
  clientFilter?: { clientId?: Types.ObjectId };
}) {
  const { stationRef, clientFilter } = params;
  const to = Math.min(params.to.getTime(), Date.now());
  const from = params.from.getTime();
  if (!(from < to)) throw new StatsRangeError('from must be before to');
  if (to - from > MAX_RANGE_DAYS * 86_400_000 + STEP_MS) {
    throw new StatsRangeError(`Range is limited to ${MAX_RANGE_DAYS} days`);
  }

  const filter: Record<string, unknown> = Types.ObjectId.isValid(stationRef)
    ? { _id: new Types.ObjectId(stationRef) }
    : { cpId: stationRef };
  if (clientFilter?.clientId) {
    filter.$or = [{ clientId: clientFilter.clientId }, { linkedClientIds: clientFilter.clientId }];
  }
  const cp = await ChargePoint.findOne(filter)
    .select('_id cpId name electricalConfig chargePointModel numberOfConnectors')
    .lean();
  if (!cp) return null;

  const [connectors, docs] = await Promise.all([
    Connector.find({ chargePointId: cp._id, connectorId: { $gt: 0 } })
      .select('connectorId powerKw ratedPowerKw connectorType')
      .sort({ connectorId: 1 })
      .lean(),
    MeterValue.find({
      chargePointId: cp._id,
      // a little before `from` so the first minute has a value to hold
      timestamp: { $gte: new Date(from - HOLD_MS), $lte: new Date(to) },
    })
      .select('connectorId transactionId timestamp sampledValue')
      .sort({ timestamp: 1 })
      .lean(),
  ]);

  const samples: PowerSample[] = [];
  for (const d of docs) {
    const sv = (d.sampledValue ?? []) as SV[];
    samples.push({
      connectorId: d.connectorId,
      ts: new Date(d.timestamp).getTime(),
      transactionId: d.transactionId ?? null,
      powerW: totalOf(sv, 'Power.Active.Import', 'kW'),
      energyWh: totalOf(sv, 'Energy.Active.Import.Register', 'kWh'),
      end: sv.some((s) => s.context === 'Transaction.End'),
    });
  }

  const stats = computeStationPowerStats(samples, {
    from,
    to,
    connectorIds: connectors.map((c) => c.connectorId),
  });

  const ec = cp.electricalConfig as { ratedCapacityKW?: number; configuredGridLimitKW?: number } | undefined;
  return {
    station: {
      id: String(cp._id),
      cpId: cp.cpId,
      name: cp.name ?? cp.cpId,
      model: cp.chargePointModel ?? null,
      ratedCapacityKw: ec?.ratedCapacityKW ?? null,
      gridLimitKw: ec?.configuredGridLimitKW ?? null,
      connectors: connectors.map((c) => ({
        connectorId: c.connectorId,
        ratedKw: c.ratedPowerKw ?? c.powerKw ?? null,
        type: (c as { connectorType?: string }).connectorType ?? null,
      })),
    },
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    ...stats,
  };
}

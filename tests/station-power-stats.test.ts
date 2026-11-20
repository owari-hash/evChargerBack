import { computeStationPowerStats, type PowerSample } from '../src/services/stationPowerStats.service';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

const T0 = Date.UTC(2026, 10, 1, 2, 0, 0); // 10:00 Ulaanbaatar
const min = (m: number) => T0 + m * 60_000;

// Gun 1 charges alone at 60 kW for 30 min, then gun 2 joins and both sit at
// 30 kW for 20 min, then gun 1 stops and gun 2 climbs back to 60 kW.
const samples: PowerSample[] = [];
for (let m = 0; m < 50; m++) samples.push({ connectorId: 1, ts: min(m) + 5_000, powerW: m < 30 ? 60_000 : 30_000, transactionId: 1 });
samples.push({ connectorId: 1, ts: min(50) + 5_000, end: true, transactionId: 1 });
for (let m = 30; m < 70; m++) samples.push({ connectorId: 2, ts: min(m) + 5_000, powerW: m < 50 ? 30_000 : 60_000, transactionId: 2 });
samples.push({ connectorId: 2, ts: min(70) + 5_000, end: true, transactionId: 2 });

const s = computeStationPowerStats(samples, { from: min(0), to: min(90), connectorIds: [1, 2] });
assert(s.summary.peakKw === 60, `station peak is 60 kW (got ${s.summary.peakKw})`);
assert(s.summary.chargingMinutes === 70, `70 charging minutes (got ${s.summary.chargingMinutes})`);
assert(s.summary.simultaneousMinutes === 20, `20 simultaneous minutes (got ${s.summary.simultaneousMinutes})`);
assert(s.summary.maxSimultaneous === 2, 'two guns at once');
assert(s.summary.sessions === 2, 'two sessions');
assert(Math.abs(s.summary.energyKwh - 70) < 0.5, `≈70 kWh (got ${s.summary.energyKwh})`);
assert(s.sharing.splits[0].piles.map((p) => p.kw).join('+') === '30+30', 'shared split is 30 + 30');
const c1 = s.connectors.find((c) => c.connectorId === 1)!;
assert(c1.soloAvgKw === 60 && c1.sharedAvgKw === 30, 'gun 1: 60 alone, 30 shared');
assert(s.days.length === 1 && s.days[0].date === '2026-11-01', 'one local day');

// Energy-register fallback when no power is reported: 1 kWh per minute = 60 kW
const e: PowerSample[] = [];
for (let m = 0; m <= 10; m++) e.push({ connectorId: 1, ts: min(m), energyWh: m * 1000, transactionId: 9 });
const se = computeStationPowerStats(e, { from: min(0), to: min(10) });
assert(se.summary.peakKw === 60, `derived power 60 kW (got ${se.summary.peakKw})`);

// Real data from the META station audit export, if present
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const audit = require('../../station-audit.json');
  const real: PowerSample[] = audit.meterValues.map((d: any) => {
    const sv = d.sampledValue as any[];
    const p = sv.find((x) => x.measurand === 'Power.Active.Import');
    const en = sv.find((x) => x.measurand === 'Energy.Active.Import.Register');
    return {
      connectorId: d.connectorId,
      ts: Date.parse(d.timestamp),
      transactionId: d.transactionId,
      powerW: p ? Number(p.value) : undefined,
      energyWh: en ? Number(en.value) : undefined,
      end: sv.some((x) => x.context === 'Transaction.End'),
    };
  });
  const ts = real.map((r) => r.ts);
  const r = computeStationPowerStats(real, { from: Math.min(...ts), to: Math.max(...ts) + 60_000 });
  console.log('\nMETA station:', JSON.stringify({ summary: r.summary, connectors: r.connectors, sharing: r.sharing, days: r.days.slice(0, 5) }, null, 1));
} catch (err) {
  console.log('(audit file not available)', (err as Error).message);
}
console.log('\nAll station power stats tests passed.');

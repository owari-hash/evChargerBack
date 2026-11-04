/**
 * Fills startSocPercent on past sessions from their first stored SoC meter value.
 *
 *   npm run backfill:start-soc             write the values
 *   npm run backfill:start-soc -- --dry    show what would change only
 *
 * Safe to re-run: sessions that already have a start SoC are skipped.
 */
import { connectDatabase, disconnectDatabase } from '../src/lib/db';
import { logger } from '../src/lib/logger';
import { MeterValue } from '../src/models/MeterValue';
import { Transaction } from '../src/models/Transaction';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry');
  await connectDatabase();

  const pending = await Transaction.find({
    $or: [{ startSocPercent: { $exists: false } }, { startSocPercent: null }],
  })
    .select('_id vehicleSoc')
    .lean();

  let filled = 0;
  for (const tx of pending) {
    const first = await MeterValue.findOne({ transactionId: tx._id, 'sampledValue.measurand': 'SoC' })
      .sort({ timestamp: 1 })
      .lean();
    const sv = first?.sampledValue.find((s) => s.measurand === 'SoC' && Number.isFinite(Number(s.value)));
    const soc = sv ? Number(sv.value) : tx.vehicleSoc ?? undefined;
    if (soc === undefined || soc === null) continue;

    filled += 1;
    if (!dryRun) await Transaction.updateOne({ _id: tx._id }, { $set: { startSocPercent: soc } });
  }

  logger.info({ checked: pending.length, filled, dryRun }, 'start SoC backfill done');
  await disconnectDatabase();
}

main().catch(async (err) => {
  logger.error({ err }, 'start SoC backfill failed');
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});

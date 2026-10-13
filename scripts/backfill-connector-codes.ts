/**
 * Gives every existing physical connector the short code behind its QR sticker.
 *
 *   npm run backfill:connector-codes             mint codes, print the list
 *   npm run backfill:connector-codes -- --dry    show what would change only
 *
 * Safe to re-run: a connector that already has a code keeps it, because by then
 * the sticker may already be on the charger.
 */
import { connectDatabase, disconnectDatabase } from '../src/lib/db';
import { logger } from '../src/lib/logger';
import { ChargePoint } from '../src/models/ChargePoint';
import { Connector } from '../src/models/Connector';
import { connectorQrUrl, mintUniqueCode } from '../src/services/connector.service';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry');
  await connectDatabase();

  // connectorId 0 is the station as a whole, not a gun — it gets no sticker.
  const pending = await Connector.find({
    connectorId: { $gt: 0 },
    $or: [{ code: { $exists: false } }, { code: null }, { code: '' }],
  })
    .sort({ chargePointId: 1, connectorId: 1 })
    .lean();

  if (pending.length === 0) {
    logger.info('every connector already has a code');
    await disconnectDatabase();
    return;
  }

  const stations = new Map<string, string>();
  for (const cp of await ChargePoint.find().select('cpId name').lean()) {
    stations.set(String(cp._id), cp.name?.trim() || cp.cpId);
  }

  logger.info({ count: pending.length, dryRun }, 'minting connector codes');

  let minted = 0;
  for (const connector of pending) {
    const station = stations.get(String(connector.chargePointId)) ?? '(unknown station)';

    if (dryRun) {
      console.log(`would mint  ${station} · гарц ${connector.connectorId}`);
      continue;
    }

    const code = await mintUniqueCode();
    await Connector.updateOne({ _id: connector._id }, { $set: { code } });
    minted++;
    console.log(
      `${code}  ${station} · гарц ${connector.connectorId}  →  ${connectorQrUrl(code)}`,
    );
  }

  logger.info({ minted, skipped: pending.length - minted }, 'backfill complete');
  await disconnectDatabase();
}

main().catch(async (err: unknown) => {
  logger.error({ err }, 'backfill failed');
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});

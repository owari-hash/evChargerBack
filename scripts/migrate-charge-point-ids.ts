/**
 * One-way migration to the ObjectId charge point identity.
 *
 *   npm run migrate:cp-ids -- --dry-run    report what would change
 *   npm run migrate:cp-ids                 apply it
 *
 * Before: `chargepoints._id` was the OCPP identifier ("CP-UB-001"), and every
 * other collection stored that same string in `chargePointId`.
 *
 * After:  `chargepoints._id` is a generated ObjectId and the OCPP identifier
 * lives in `cpId`. Every other collection references the ObjectId, so renaming a
 * station is a one-field update instead of a cascade.
 *
 * The work is done through the raw driver rather than the models, because the
 * models now describe the new shape and would refuse to read the old one.
 *
 * It is safe to re-run: charge points that already have an ObjectId `_id` are
 * left alone, and a reference that is already an ObjectId is not touched. It is
 * NOT atomic — take a backup first.
 */
import mongoose from 'mongoose';
import { ObjectId } from 'mongodb';
import { env } from '../src/config/env';
import { disconnectDatabase } from '../src/lib/db';
import { logger } from '../src/lib/logger';

// Importing the models registers them, which is how the collections carrying a
// chargePointId are discovered instead of being listed here by hand.
import '../src/models/ChargePoint';
import '../src/models/ChargingProfile';
import '../src/models/ConfigurationKey';
import '../src/models/Connector';
import '../src/models/IdTag';
import '../src/models/Job';
import '../src/models/Log';
import '../src/models/MeterValue';
import '../src/models/Payment';
import '../src/models/Reservation';
import '../src/models/Security';
import '../src/models/Transaction';
import '../src/models/Wallet';

// Mongoose builds declared indexes on connect. The unique `cpId` index cannot
// exist while the old rows are still there — every one of them would have a null
// cpId — so index building is turned off and the index is created at the end,
// after the data has been moved. It also keeps a dry run genuinely read-only.
mongoose.set('autoIndex', false);

const dryRun = process.argv.slice(2).includes('--dry-run');
const tag = dryRun ? '[dry run] ' : '';

async function main(): Promise<number> {
  // Connecting directly rather than through connectDatabase(), which builds the
  // declared indexes — including the unique cpId index this migration is what
  // makes buildable in the first place.
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  const db = mongoose.connection.db;
  if (!db) throw new Error('no database handle');

  const chargePoints = db.collection('chargepoints');

  // --- 1. Charge points -----------------------------------------------------
  const legacy = await chargePoints.find<{ _id: unknown }>({ _id: { $type: 'string' } }).toArray();
  if (legacy.length === 0) {
    const total = await chargePoints.countDocuments();
    logger.info(`nothing to migrate — ${total} charge points already use an ObjectId _id`);
    return 0;
  }

  // A station that somehow already holds the new identifier must not be
  // duplicated by this run.
  const taken = new Set(
    (await chargePoints.find<{ cpId?: string }>({ cpId: { $exists: true } }).toArray())
      .map((cp) => cp.cpId)
      .filter(Boolean) as string[],
  );

  const mapping = new Map<string, ObjectId>();
  for (const doc of legacy) {
    const cpId = String(doc._id);
    if (taken.has(cpId)) {
      logger.error(`${cpId} already exists under an ObjectId _id — resolve that by hand first`);
      return 1;
    }
    mapping.set(cpId, new ObjectId());
  }

  logger.info(`${tag}migrating ${mapping.size} charge points`);

  if (!dryRun) {
    for (const doc of legacy) {
      const { _id, ...rest } = doc as Record<string, unknown> & { _id: unknown };
      await chargePoints.insertOne({ _id: mapping.get(String(_id))!, cpId: String(_id), ...rest });
    }
  }

  // --- 2. Everything that references a charge point -------------------------
  const counts: Record<string, number> = {};

  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name);
    if (!model.schema.path('chargePointId')) continue;

    const collection = db.collection(model.collection.name);
    let moved = 0;
    for (const [cpId, ref] of mapping) {
      // Security events keep the identifier that was presented, which is the
      // fact that matters when the station was never recognised.
      const extra = name === 'SecurityEvent' ? { cpId } : {};
      if (dryRun) {
        moved += await collection.countDocuments({ chargePointId: cpId });
      } else {
        const result = await collection.updateMany(
          { chargePointId: cpId },
          { $set: { chargePointId: ref, ...extra } },
        );
        moved += result.modifiedCount;
      }
    }
    if (moved) counts[name] = moved;
  }

  // --- 3. Collections that key on the identifier rather than a field --------
  const versions = db.collection('locallistversions');
  const legacyVersions = await versions.find<{ _id: unknown }>({ _id: { $type: 'string' } }).toArray();
  for (const doc of legacyVersions) {
    const ref = mapping.get(String(doc._id));
    if (!ref) continue;
    if (!dryRun) {
      const { _id, ...rest } = doc as Record<string, unknown> & { _id: unknown };
      await versions.insertOne({ _id: new ObjectId(), chargePointId: ref, ...rest });
      await versions.deleteOne({ _id: _id as ObjectId });
    }
    counts.LocalListVersion = (counts.LocalListVersion ?? 0) + 1;
  }

  // --- 4. The tag allow-list holds identifiers inside an array --------------
  const idTags = db.collection('idtags');
  const restricted = await idTags
    .find<{ _id: unknown; allowedChargePointIds?: unknown[] }>({
      'allowedChargePointIds.0': { $type: 'string' },
    })
    .toArray();
  for (const tagDoc of restricted) {
    const resolved = (tagDoc.allowedChargePointIds ?? [])
      .map((value) => (typeof value === 'string' ? mapping.get(value) : (value as ObjectId)))
      .filter(Boolean);
    if (!dryRun) {
      await idTags.updateOne(
        { _id: tagDoc._id as ObjectId },
        { $set: { allowedChargePointIds: resolved } },
      );
    }
    counts.IdTagAllowList = (counts.IdTagAllowList ?? 0) + 1;
  }

  // --- 5. Drop the old rows and make sure the new index exists --------------
  if (!dryRun) {
    await chargePoints.deleteMany({ _id: { $type: 'string' } });
    await chargePoints.createIndex({ cpId: 1 }, { unique: true });
  }

  const summary = Object.entries(counts)
    .map(([name, n]) => `${name} ${n}`)
    .join(', ');
  logger.info(`${tag}charge points ${mapping.size} — references moved: ${summary || 'none'}`);
  if (dryRun) logger.warn('dry run — nothing was written');

  return 0;
}

main()
  .then(async (code) => {
    await disconnectDatabase();
    process.exit(code);
  })
  .catch(async (err) => {
    logger.error({ err }, 'migration failed');
    await disconnectDatabase().catch(() => undefined);
    process.exit(1);
  });

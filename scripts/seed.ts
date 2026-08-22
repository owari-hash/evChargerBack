/**
 * Bootstrap script.
 *
 *   npm run seed              create the admin user + demo data
 *   npm run seed -- --ca      also generate the local CA key pair
 *   npm run seed -- --ca-only only generate the CA
 */
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { env } from '../src/config/env';
import { connectDatabase, disconnectDatabase } from '../src/lib/db';
import { logger } from '../src/lib/logger';
import { ChargePoint } from '../src/models/ChargePoint';
import { Connector } from '../src/models/Connector';
import { IdTag } from '../src/models/IdTag';
import { User, hashPassword } from '../src/models/User';
import { generateCa } from '../src/services/ca.service';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const wantCa = args.includes('--ca') || args.includes('--ca-only');
  const caOnly = args.includes('--ca-only');

  if (wantCa) {
    if (existsSync(env.CSMS_CA_CERT_PATH) && !args.includes('--force')) {
      logger.info(`CA already exists at ${env.CSMS_CA_CERT_PATH}; pass --force to overwrite`);
    } else {
      generateCa();
      logger.info(`CA written to ${env.CSMS_CA_CERT_PATH} and ${env.CSMS_CA_KEY_PATH}`);
    }
    if (caOnly) return;
  }

  await connectDatabase();

  // --- admin user ---
  const email = env.ADMIN_EMAIL.toLowerCase();
  const existing = await User.findOne({ email });
  if (existing) {
    logger.info(`admin user ${email} already exists`);
  } else {
    await User.create({
      email,
      passwordHash: await hashPassword(env.ADMIN_PASSWORD),
      name: 'Administrator',
      role: 'ADMIN',
    });
    logger.info(`created admin user ${email}`);
  }

  // --- demo charge point ---
  const demoId = 'CP-DEMO-001';
  if (!(await ChargePoint.exists({ cpId: demoId }))) {
    const key = randomBytes(20).toString('hex');
    const demo = await ChargePoint.create({
      cpId: demoId,
      name: 'Demo charge point',
      authorizationKeyHash: await bcrypt.hash(key, 12),
      securityProfile: 1,
      heartbeatInterval: env.OCPP_HEARTBEAT_INTERVAL,
      tariffPerKwh: 450,
    });
    await Connector.bulkWrite(
      [0, 1, 2].map((connectorId) => ({
        updateOne: {
          filter: { chargePointId: demo._id, connectorId },
          update: { $setOnInsert: { chargePointId: demo._id, connectorId } },
          upsert: true,
        },
      })),
    );
    logger.info(`created ${demoId} with AuthorizationKey: ${key}`);
  }

  // --- demo tags ---
  const tags = [
    { _id: 'TAG-0001', label: 'Demo card 1', status: 'Accepted' as const },
    { _id: 'TAG-0002', label: 'Demo card 2', status: 'Accepted' as const },
    { _id: 'TAG-BLOCKED', label: 'Blocked card', status: 'Blocked' as const },
  ];
  for (const t of tags) {
    await IdTag.updateOne({ _id: t._id }, { $setOnInsert: t }, { upsert: true });
  }
  logger.info(`ensured ${tags.length} demo idTags`);
}

main()
  .then(() => disconnectDatabase())
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'seed failed');
    process.exit(1);
  });

import type { Types } from 'mongoose';
import { env } from '../config/env';
import { generateConnectorCode } from '../lib/connectorCode';
import { logger } from '../lib/logger';
import { Connector } from '../models/Connector';

/**
 * Minting and resolving the short codes behind connector QR stickers.
 */

/** Duplicate key — the only error worth retrying a mint for. */
function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number })?.code === 11000;
}

/**
 * Gives a connector a code if it has none, and returns it.
 *
 * Idempotent and safe to call on every StatusNotification: a connector that
 * already has a code keeps it, which is the whole point — the sticker is
 * already on the charger. connectorId 0 is the station as a whole, not a gun,
 * so it never gets one.
 */
export async function ensureConnectorCode(
  chargePointId: Types.ObjectId,
  connectorId: number,
): Promise<string | null> {
  if (connectorId <= 0) return null;

  const existing = await Connector.findOne({ chargePointId, connectorId })
    .select('code')
    .lean();
  if (!existing) return null;
  if (existing.code) return existing.code;

  // 30^6 keeps collisions vanishingly rare; a few attempts cover the tail.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateConnectorCode();
    try {
      const updated = await Connector.findOneAndUpdate(
        // `code` absent guards against two concurrent callers both minting.
        { chargePointId, connectorId, code: { $in: [null, ''] } },
        { $set: { code } },
        { new: true },
      )
        .select('code')
        .lean();

      if (updated?.code) return updated.code;

      // Someone else won the race; take whatever they assigned.
      const reread = await Connector.findOne({ chargePointId, connectorId })
        .select('code')
        .lean();
      if (reread?.code) return reread.code;
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      logger.warn({ chargePointId, connectorId, attempt }, 'connector code collision, retrying');
    }
  }

  logger.error({ chargePointId, connectorId }, 'could not mint a connector code');
  return null;
}

/** A code for a connector being created in one go, retried past collisions. */
export async function mintUniqueCode(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateConnectorCode();
    if (!(await Connector.exists({ code }))) return code;
  }
  // Astronomically unlikely; surface it rather than return a known-colliding code.
  throw new Error('Could not generate a unique connector code');
}

/**
 * The URL printed on the sticker. Short on purpose: fewer characters means a
 * sparser QR, which scans better off a scratched label in the cold.
 */
export function connectorQrUrl(code: string): string {
  return `${env.PUBLIC_BASE_URL}/c/${code}`;
}

import { IdTag } from '../models/IdTag';
import { Transaction } from '../models/Transaction';
import type { AuthorizationStatus } from '../models/enums';
import type { IdTagInfo } from '../ocpp/schemas/common';

export interface AuthorizeOptions {
  /** Ignore the concurrent-transaction limit (used when stopping a transaction). */
  skipConcurrencyCheck?: boolean;
  /** Charge point the tag is being presented at, for the allow-list check. */
  chargePointId?: string;
}

/**
 * Resolve an idTag to an OCPP IdTagInfo.
 *
 * Unknown tags are Invalid. A tag whose expiryDate has passed is Expired.
 * A tag that already has `maxActiveTransactions` running transactions is
 * ConcurrentTx.
 */
export async function authorizeIdTag(
  idTag: string,
  opts: AuthorizeOptions = {},
): Promise<IdTagInfo> {
  const tag = await IdTag.findById(idTag).lean();

  if (!tag) {
    return { status: 'Invalid' };
  }

  const base = {
    parentIdTag: tag.parentIdTag ?? undefined,
    expiryDate: tag.expiryDate ?? undefined,
  };

  if (tag.status !== 'Accepted') {
    return { ...base, status: tag.status as AuthorizationStatus };
  }

  if (tag.expiryDate && tag.expiryDate.getTime() <= Date.now()) {
    return { ...base, status: 'Expired' };
  }

  if (
    opts.chargePointId &&
    Array.isArray(tag.allowedChargePointIds) &&
    tag.allowedChargePointIds.length > 0 &&
    !tag.allowedChargePointIds.includes(opts.chargePointId)
  ) {
    return { ...base, status: 'Blocked' };
  }

  const limit = tag.maxActiveTransactions ?? 1;
  if (!opts.skipConcurrencyCheck && limit > 0) {
    const active = await Transaction.countDocuments({ idTag, status: 'Active' });
    if (active >= limit) {
      return { ...base, status: 'ConcurrentTx' };
    }
  }

  return { ...base, status: 'Accepted' };
}

/** True when the tag (or its parent) may stop the given transaction. */
export async function canStopTransaction(idTag: string, transactionIdTag: string): Promise<boolean> {
  if (idTag === transactionIdTag) return true;
  const [a, b] = await Promise.all([
    IdTag.findById(idTag).lean(),
    IdTag.findById(transactionIdTag).lean(),
  ]);
  if (!a || a.status !== 'Accepted') return false;
  // Same parent group may stop each other's transactions (OCPP 1.6 §4.9).
  return Boolean(a.parentIdTag && b?.parentIdTag && a.parentIdTag === b.parentIdTag);
}

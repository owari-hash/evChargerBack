import type { Types } from 'mongoose';
import { env } from '../config/env';
import { cpIdFor } from '../lib/chargePointRef';
import { badRequest, conflict, notFound, serviceUnavailable } from '../lib/errors';
import { logger } from '../lib/logger';
import { IdTag } from '../models/IdTag';
import {
  Wallet,
  WalletEntry,
  type WalletDoc,
  type WalletEntryType,
  type WalletOwnerType,
} from '../models/Wallet';
import { bus } from '../realtime/events';

/**
 * Prepaid wallet balances and their ledger.
 *
 * Every balance change goes through `credit`/`debit`, which move the money with
 * a single atomic `$inc` and then write the ledger entry. The entry carries a
 * unique `idempotencyKey`, so a replayed QPay callback or a repeated
 * reconciliation sweep credits the wallet exactly once.
 */

const walletLogger = logger.child({ module: 'wallet' });

export interface WalletOwner {
  ownerType: WalletOwnerType;
  ownerId: string;
}

function assertEnabled(): void {
  if (!env.WALLET_ENABLED) {
    throw serviceUnavailable('Wallets are disabled (WALLET_ENABLED=false)');
  }
}

/** MNT is settled in whole tugrik; reject anything that is not a positive integer. */
function normaliseAmount(amount: number, field = 'amount'): number {
  const rounded = Math.round(amount);
  if (!Number.isFinite(rounded) || rounded <= 0) {
    throw badRequest(`${field} must be a positive number of tugrik`);
  }
  return rounded;
}

export function normaliseOwner(ownerType: string, ownerId: string): WalletOwner {
  const type = ownerType.toUpperCase();
  if (type !== 'USER' && type !== 'IDTAG') {
    throw badRequest("ownerType must be 'USER' or 'IDTAG'");
  }
  const id = ownerId.trim();
  if (!id) throw badRequest('ownerId is required');
  return { ownerType: type, ownerId: id };
}

/**
 * Which wallet an idTag spends from: its own by default, or the wallet it has
 * been bound to (a driver account, so every card the driver owns shares one
 * balance). Returns null for a tag the CSMS has never seen.
 */
export async function resolveWalletOwnerForIdTag(idTag: string): Promise<WalletOwner | null> {
  const tag = await IdTag.findById(idTag).select('walletOwnerType walletOwnerId').lean();
  if (!tag) return null;
  if (tag.walletOwnerId) {
    return normaliseOwner(tag.walletOwnerType ?? 'USER', tag.walletOwnerId);
  }
  return { ownerType: 'IDTAG', ownerId: idTag };
}

/** Point an idTag at a wallet, so charges against the tag draw on that balance. */
export async function bindIdTagToWallet(idTag: string, owner: WalletOwner): Promise<void> {
  const result = await IdTag.updateOne(
    { _id: idTag },
    { $set: { walletOwnerType: owner.ownerType, walletOwnerId: owner.ownerId } },
  );
  if (result.matchedCount === 0) throw notFound(`idTag ${idTag} not found`);
  await getOrCreateWallet(owner);
}

/** Remove the binding; the tag falls back to its own wallet. */
export async function unbindIdTagFromWallet(idTag: string): Promise<void> {
  const result = await IdTag.updateOne(
    { _id: idTag },
    { $unset: { walletOwnerType: '', walletOwnerId: '' } },
  );
  if (result.matchedCount === 0) throw notFound(`idTag ${idTag} not found`);
}

/** Every idTag bound to a wallet, so the account screen can list the driver's cards. */
export async function idTagsForWallet(owner: WalletOwner): Promise<string[]> {
  const tags = await IdTag.find({
    walletOwnerType: owner.ownerType,
    walletOwnerId: owner.ownerId,
  })
    .select('_id')
    .lean();
  return tags.map((t) => String(t._id));
}

/**
 * The wallet for an owner, created on first read. Upsert rather than
 * find-then-create so two concurrent top-ups cannot race into two wallets — the
 * unique index on (ownerType, ownerId) is what makes that safe.
 */
export async function getOrCreateWallet(
  owner: WalletOwner,
  defaults: { label?: string } = {},
): Promise<WalletDoc> {
  const wallet = await Wallet.findOneAndUpdate(
    { ownerType: owner.ownerType, ownerId: owner.ownerId },
    {
      $setOnInsert: {
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        balance: 0,
        currency: 'MNT',
        status: 'ACTIVE',
        ...(defaults.label ? { label: defaults.label } : {}),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  return wallet as WalletDoc;
}

export async function findWallet(owner: WalletOwner): Promise<WalletDoc | null> {
  return Wallet.findOne({ ownerType: owner.ownerType, ownerId: owner.ownerId });
}

/** Balance of an owner that may not have a wallet yet — zero rather than a 404. */
export async function balanceOf(owner: WalletOwner): Promise<number> {
  const wallet = await Wallet.findOne({
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
  })
    .select('balance')
    .lean();
  return wallet?.balance ?? 0;
}

export interface LedgerRef {
  description?: string;
  /** Makes the movement replay-safe; a duplicate key returns the original entry. */
  idempotencyKey?: string;
  paymentId?: string;
  transactionId?: number;
  chargePointId?: Types.ObjectId;
  connectorId?: number;
  idTag?: string;
  createdBy?: string;
}

export interface WalletMovement {
  wallet: WalletDoc;
  /** The ledger entry, or null when an idempotency key showed this already ran. */
  entryId: string | null;
  amount: number;
  balance: number;
  /** True when the key had already been used and no money moved this time. */
  duplicate: boolean;
}

/** Has this idempotency key already moved money? */
async function existingEntry(key: string | undefined) {
  if (!key) return null;
  return WalletEntry.findOne({ idempotencyKey: key }).lean();
}

/**
 * Add money to a wallet. Used by settled QPay top-ups, refunds and manual
 * operator credits.
 */
export async function credit(
  owner: WalletOwner,
  amount: number,
  type: Extract<WalletEntryType, 'TOPUP' | 'REFUND' | 'BONUS' | 'ADJUSTMENT'>,
  ref: LedgerRef = {},
): Promise<WalletMovement> {
  assertEnabled();
  const value = normaliseAmount(amount);

  const already = await existingEntry(ref.idempotencyKey);
  if (already) {
    const wallet = await getOrCreateWallet(owner);
    return {
      wallet,
      entryId: String(already._id),
      amount: already.amount,
      balance: wallet.balance ?? 0,
      duplicate: true,
    };
  }

  const now = new Date();
  const wallet = (await Wallet.findOneAndUpdate(
    { ownerType: owner.ownerType, ownerId: owner.ownerId },
    {
      $inc: { balance: value, ...(type === 'TOPUP' ? { totalToppedUp: value } : {}) },
      $set: { ...(type === 'TOPUP' ? { lastTopUpAt: now } : {}) },
      $setOnInsert: { ownerType: owner.ownerType, ownerId: owner.ownerId, currency: 'MNT' },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  )) as WalletDoc;

  const entry = await writeEntry(wallet, owner, value, type, ref).catch(async (err) => {
    // A duplicate key means a concurrent caller won the race with the same
    // idempotency key — undo our $inc so the money is only counted once.
    if ((err as { code?: number }).code === 11000) {
      await Wallet.updateOne(
        { _id: wallet._id },
        { $inc: { balance: -value, ...(type === 'TOPUP' ? { totalToppedUp: -value } : {}) } },
      );
      return null;
    }
    throw err;
  });

  if (!entry) {
    const current = await getOrCreateWallet(owner);
    return {
      wallet: current,
      entryId: null,
      amount: value,
      balance: current.balance ?? 0,
      duplicate: true,
    };
  }

  bus.emitEvent('wallet.credited', await cpIdFor(ref.chargePointId), {
    walletId: String(wallet._id),
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    type,
    amount: value,
    balance: wallet.balance ?? 0,
    paymentId: ref.paymentId,
    idTag: ref.idTag,
  });

  walletLogger.info(
    { owner, type, amount: value, balance: wallet.balance, paymentId: ref.paymentId },
    'wallet credited',
  );

  return {
    wallet,
    entryId: String(entry._id),
    amount: value,
    balance: wallet.balance ?? 0,
    duplicate: false,
  };
}

export interface DebitOptions {
  /**
   * Allow the balance to go below zero. Defaults to WALLET_ALLOW_NEGATIVE — a
   * session that outran the balance leaves a debt rather than being written off.
   */
  allowNegative?: boolean;
}

/** Take money out of a wallet: a finished charging session, or a correction. */
export async function debit(
  owner: WalletOwner,
  amount: number,
  type: Extract<WalletEntryType, 'CHARGE' | 'ADJUSTMENT'>,
  ref: LedgerRef = {},
  opts: DebitOptions = {},
): Promise<WalletMovement> {
  assertEnabled();
  const value = normaliseAmount(amount);
  const allowNegative = opts.allowNegative ?? env.WALLET_ALLOW_NEGATIVE;

  const already = await existingEntry(ref.idempotencyKey);
  if (already) {
    const wallet = await getOrCreateWallet(owner);
    return {
      wallet,
      entryId: String(already._id),
      amount: already.amount,
      balance: wallet.balance ?? 0,
      duplicate: true,
    };
  }

  const now = new Date();
  // With allowNegative off, the balance condition is part of the query so the
  // check and the decrement are one atomic operation.
  const filter: Record<string, unknown> = {
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    ...(allowNegative ? {} : { balance: { $gte: value } }),
  };

  const wallet = (await Wallet.findOneAndUpdate(
    filter,
    {
      $inc: { balance: -value, totalSpent: value },
      $set: { lastSpendAt: now },
      $setOnInsert: { ownerType: owner.ownerType, ownerId: owner.ownerId, currency: 'MNT' },
    },
    {
      new: true,
      // A driver charging before they ever topped up has no wallet yet; create
      // one so the debt is recorded instead of silently written off. Never
      // upsert when the balance condition is part of the filter — that would
      // insert a wallet that does not satisfy it.
      upsert: allowNegative,
      setDefaultsOnInsert: allowNegative,
    },
  )) as WalletDoc | null;

  if (!wallet) {
    const current = await findWallet(owner);
    if (!current) throw notFound('Wallet not found');
    throw conflict(
      `Insufficient balance: ${current.balance ?? 0} MNT available, ${value} MNT required`,
    );
  }

  const entry = await writeEntry(wallet, owner, -value, type, ref).catch(async (err) => {
    if ((err as { code?: number }).code === 11000) {
      await Wallet.updateOne(
        { _id: wallet._id },
        { $inc: { balance: value, totalSpent: -value } },
      );
      return null;
    }
    throw err;
  });

  if (!entry) {
    const current = await getOrCreateWallet(owner);
    return {
      wallet: current,
      entryId: null,
      amount: -value,
      balance: current.balance ?? 0,
      duplicate: true,
    };
  }

  bus.emitEvent('wallet.debited', await cpIdFor(ref.chargePointId), {
    walletId: String(wallet._id),
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    type,
    amount: value,
    balance: wallet.balance ?? 0,
    transactionId: ref.transactionId,
    idTag: ref.idTag,
  });

  walletLogger.info(
    { owner, type, amount: value, balance: wallet.balance, transactionId: ref.transactionId },
    'wallet debited',
  );

  return {
    wallet,
    entryId: String(entry._id),
    amount: -value,
    balance: wallet.balance ?? 0,
    duplicate: false,
  };
}

async function writeEntry(
  wallet: WalletDoc,
  owner: WalletOwner,
  signedAmount: number,
  type: WalletEntryType,
  ref: LedgerRef,
) {
  return WalletEntry.create({
    walletId: wallet._id,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    type,
    amount: signedAmount,
    balanceAfter: wallet.balance ?? 0,
    currency: wallet.currency ?? 'MNT',
    description: ref.description,
    idempotencyKey: ref.idempotencyKey,
    paymentId: ref.paymentId,
    transactionId: ref.transactionId,
    chargePointId: ref.chargePointId,
    connectorId: ref.connectorId,
    idTag: ref.idTag,
    createdBy: ref.createdBy ?? 'system',
  });
}

/**
 * Charge a finished session to the wallet behind its idTag. Never throws: a
 * billing problem must not fail the OCPP StopTransaction the charge point is
 * waiting on, so failures are logged and left for reconciliation.
 */
export async function chargeSessionToWallet(input: {
  transactionId: number;
  idTag: string;
  amount: number;
  chargePointId?: Types.ObjectId;
  connectorId?: number;
  energyWh?: number;
}): Promise<WalletMovement | null> {
  if (!env.WALLET_ENABLED) return null;
  const amount = Math.round(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  try {
    const owner = await resolveWalletOwnerForIdTag(input.idTag);
    if (!owner) return null;

    const kwh = ((input.energyWh ?? 0) / 1000).toFixed(2);
    return await debit(
      owner,
      amount,
      'CHARGE',
      {
        description: `Цэнэглэлт #${input.transactionId} · ${kwh} кВт·ц`,
        idempotencyKey: `transaction:${input.transactionId}`,
        transactionId: input.transactionId,
        chargePointId: input.chargePointId,
        connectorId: input.connectorId,
        idTag: input.idTag,
      },
      // Always settle the full cost: the shortfall becomes a debt the next
      // top-up clears, rather than energy nobody pays for.
      { allowNegative: true },
    );
  } catch (err) {
    walletLogger.error(
      { err: (err as Error).message, transactionId: input.transactionId, idTag: input.idTag },
      'failed to charge session to wallet',
    );
    return null;
  }
}

/**
 * Whether an idTag has enough balance to start a session. Used by the Authorize
 * pre-check, which only enforces it when WALLET_REQUIRE_BALANCE_TO_START is on.
 */
export async function hasBalanceToStart(idTag: string): Promise<{
  ok: boolean;
  balance: number;
  required: number;
}> {
  const required = env.WALLET_MIN_START_BALANCE;
  const owner = await resolveWalletOwnerForIdTag(idTag);
  if (!owner) return { ok: false, balance: 0, required };
  const balance = await balanceOf(owner);
  return { ok: balance >= required, balance, required };
}

export interface ListEntriesQuery {
  type?: WalletEntryType;
  from?: Date;
  to?: Date;
  skip: number;
  limit: number;
}

export async function listEntries(owner: WalletOwner, q: ListEntriesQuery) {
  const filter: Record<string, unknown> = {
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
  };
  if (q.type) filter.type = q.type;
  if (q.from || q.to) {
    filter.createdAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  }

  const [data, total] = await Promise.all([
    WalletEntry.find(filter).sort({ createdAt: -1 }).skip(q.skip).limit(q.limit).lean(),
    WalletEntry.countDocuments(filter),
  ]);

  return { data: data.map(toEntryView), total };
}

export function toWalletView(wallet: WalletDoc | Record<string, unknown>): Record<string, unknown> {
  const doc = (
    'toJSON' in wallet && typeof wallet.toJSON === 'function' ? wallet.toJSON() : wallet
  ) as Record<string, unknown>;
  doc.id = String(doc._id ?? doc.id);
  delete doc.__v;
  return doc;
}

export function toEntryView(entry: Record<string, unknown>): Record<string, unknown> {
  const doc = (
    'toJSON' in entry && typeof entry.toJSON === 'function'
      ? (entry.toJSON as () => Record<string, unknown>)()
      : { ...entry }
  ) as Record<string, unknown>;
  doc.id = String(doc._id ?? doc.id);
  doc.walletId = String(doc.walletId);
  delete doc._id;
  delete doc.__v;
  return doc;
}

/** Freeze or unfreeze a wallet. A frozen wallet still accepts top-ups. */
export async function setWalletStatus(
  owner: WalletOwner,
  status: 'ACTIVE' | 'FROZEN',
): Promise<WalletDoc> {
  const wallet = await Wallet.findOneAndUpdate(
    { ownerType: owner.ownerType, ownerId: owner.ownerId },
    { $set: { status } },
    { new: true },
  );
  if (!wallet) throw notFound('Wallet not found');
  return wallet as WalletDoc;
}

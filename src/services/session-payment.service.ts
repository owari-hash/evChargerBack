/**
 * Resolves how each charging session was paid and what the payer's wallet held after it.
 *
 * A session is funded in one of three ways:
 *  - from a prepaid wallet (a CHARGE ledger entry carrying the transactionId),
 *  - by a direct invoice settled against the session (Payment with transactionId, PAID),
 *  - not at all: free (cost 0) or an internal/organisation card that skips billing.
 */
import { IdTag } from '../models/IdTag';
import { Payment } from '../models/Payment';
import { WalletEntry } from '../models/Wallet';
import { r2, signedAmount } from './driver-statement.service';

export const SESSION_PAYMENT_METHODS = [
  'WALLET',
  'QPAY',
  'QPAY_QUICKQR',
  'GOLOMT',
  'SOCIALPAY',
  'TOKI',
  'INTERNAL',
  'FREE',
  'UNPAID',
] as const;
export type SessionPaymentMethod = (typeof SESSION_PAYMENT_METHODS)[number];

export interface SessionPaymentInfo {
  paymentMethod: SessionPaymentMethod;
  /** Net amount taken from a wallet for this session (CHARGE minus REFUND). */
  walletPaid: number;
  /** Amount settled by a direct invoice for this session. */
  directPaid: number;
  /** Wallet balance right after this session was billed (null when no wallet was involved). */
  balanceAfter: number | null;
  /** USER (app account), IDTAG (card wallet) or CLIENT (organisation). */
  walletOwnerType: string | null;
}

interface SessionLike {
  _id: number;
  idTag: string;
  cost?: number | null;
}

export async function resolveSessionPayments(
  txs: SessionLike[],
): Promise<Map<number, SessionPaymentInfo>> {
  const out = new Map<number, SessionPaymentInfo>();
  if (!txs.length) return out;

  const txIds = txs.map((t) => t._id);
  const tagIds = [...new Set(txs.map((t) => t.idTag).filter(Boolean))];

  const [entries, payments, tags] = await Promise.all([
    WalletEntry.find({ type: { $in: ['CHARGE', 'REFUND'] }, transactionId: { $in: txIds } })
      .select('transactionId type amount balanceAfter ownerType createdAt')
      .sort({ createdAt: 1, _id: 1 })
      .lean(),
    Payment.find({ transactionId: { $in: txIds }, status: 'PAID' })
      .select('transactionId provider paidAmount golomtChannel')
      .lean(),
    IdTag.find({ _id: { $in: tagIds } }).select('_id isInternal walletOwnerType').lean(),
  ]);

  const walletByTx = new Map<number, { paid: number; balanceAfter: number; ownerType: string }>();
  for (const e of entries) {
    if (e.transactionId == null) continue;
    const prev = walletByTx.get(e.transactionId);
    walletByTx.set(e.transactionId, {
      paid: (prev?.paid ?? 0) - signedAmount(e),
      // Entries are sorted oldest first, so the last one wins: the balance after any refund.
      balanceAfter: e.balanceAfter,
      ownerType: e.ownerType,
    });
  }

  const directByTx = new Map<number, (typeof payments)[number]>();
  for (const p of payments) {
    if (p.transactionId != null) directByTx.set(p.transactionId, p);
  }
  const tagById = new Map(tags.map((t) => [String(t._id), t]));

  for (const t of txs) {
    const wallet = walletByTx.get(t._id);
    const direct = directByTx.get(t._id);
    const tag = tagById.get(t.idTag);
    const cost = r2(t.cost ?? 0);
    const walletPaid = r2(wallet?.paid ?? 0);

    let paymentMethod: SessionPaymentMethod;
    if (walletPaid > 0) paymentMethod = 'WALLET';
    else if (direct) {
      paymentMethod =
        direct.provider === 'GOLOMT' && direct.golomtChannel === 'SOCIALPAY'
          ? 'SOCIALPAY'
          : (direct.provider as SessionPaymentMethod);
    } else if (tag?.isInternal || tag?.walletOwnerType === 'CLIENT') paymentMethod = 'INTERNAL';
    else if (cost === 0) paymentMethod = 'FREE';
    else paymentMethod = 'UNPAID';

    out.set(t._id, {
      paymentMethod,
      walletPaid,
      directPaid: direct ? r2(direct.paidAmount ?? 0) : 0,
      balanceAfter: wallet ? r2(wallet.balanceAfter) : null,
      walletOwnerType: wallet?.ownerType ?? tag?.walletOwnerType ?? null,
    });
  }
  return out;
}

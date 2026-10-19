import { env } from '../config/env';
import { Payment } from '../models/Payment';
import { createPayment, syncPayment, toPaymentView } from '../services/payment.service';
import {
  getOrCreateWallet,
  idTagsForWallet,
  isInternalDriver,
  listEntries,
  toWalletView,
  type WalletOwner,
} from '../services/wallet.service';
import { notFound } from './http';

/**
 * A driver's prepaid wallet: `USER/<account id>`. The account id always comes
 * from the session, never from the request, so a driver only reaches their own.
 */

const ownerFor = (userId: string): WalletOwner => ({ ownerType: 'USER', ownerId: userId });

export interface WalletConfig {
  enabled: boolean;
  currency: string;
  presets: number[];
  minTopUp: number;
  maxTopUp: number;
  minStartBalance: number;
  requireBalanceToStart: boolean;
  allowNegative: boolean;
  /** False when QPay is switched off — the top-up form has to be hidden. */
  topUpEnabled: boolean;
}

export function walletConfig(): WalletConfig {
  return {
    enabled: env.WALLET_ENABLED,
    currency: 'MNT',
    presets: env.WALLET_TOPUP_PRESETS,
    minTopUp: env.WALLET_TOPUP_MIN,
    maxTopUp: env.WALLET_TOPUP_MAX,
    minStartBalance: env.WALLET_MIN_START_BALANCE,
    requireBalanceToStart: env.WALLET_REQUIRE_BALANCE_TO_START,
    allowNegative: false,
    topUpEnabled: env.QPAY_ENABLED,
  };
}

/** The wallet, created empty on first read, with the charge tags spending from it. */
export async function getWallet(userId: string): Promise<Record<string, unknown>> {
  const owner = ownerFor(userId);
  const [wallet, idTags, isInternal] = await Promise.all([
    getOrCreateWallet(owner),
    idTagsForWallet(owner),
    isInternalDriver(userId),
  ]);
  const view = toWalletView(wallet);
  view.isInternal = isInternal;
  return { ...view, idTags, isInternal };
}

export function listWalletEntries(userId: string, limit: number) {
  return listEntries(ownerFor(userId), { skip: 0, limit });
}

/** Opens a QPay invoice that credits the wallet once it is paid. */
export async function createTopUp(input: {
  userId: string;
  amount: number;
  description: string;
  receiverCode?: string;
}): Promise<Record<string, unknown>> {
  const owner = ownerFor(input.userId);
  // The wallet has to exist before QPay's callback arrives to credit it.
  await getOrCreateWallet(owner);

  const payment = await createPayment({
    amount: input.amount,
    description: input.description,
    purpose: 'WALLET_TOPUP',
    walletOwnerType: owner.ownerType,
    walletOwnerId: owner.ownerId,
    userId: input.userId,
    receiverCode: input.receiverCode ?? input.userId,
  });
  return toPaymentView(payment);
}

/** The QR image, kept out of the invoice payload because of its size. */
export async function getTopUpQr(paymentId: string) {
  const payment = await Payment.findById(paymentId)
    .select('+qrImage')
    .lean()
    .catch(() => null);
  if (!payment) return null;
  return {
    qrText: payment.qrText,
    qrImage: payment.qrImage,
    shortUrl: payment.shortUrl,
    deeplinks: payment.deeplinks,
  };
}

/** The invoice as stored, or null for an unknown or malformed id. */
export async function getTopUp(paymentId: string): Promise<Record<string, unknown> | null> {
  const payment = await Payment.findById(paymentId)
    .lean()
    .catch(() => null);
  return payment ? toPaymentView(payment) : null;
}

/** Asks QPay whether the invoice is paid — the call that credits the wallet. */
export async function checkTopUp(paymentId: string): Promise<Record<string, unknown>> {
  const payment = await Payment.findById(paymentId).select('+callbackSecret');
  if (!payment) throw notFound('Нэхэмжлэх олдсонгүй');
  return toPaymentView(await syncPayment(payment));
}

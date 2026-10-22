import { env } from '../config/env';
import { Payment } from '../models/Payment';
import {
  createGolomtTopUp,
  createPayment,
  deleteSavedCard,
  listSavedCards,
  payGolomtTopUpWithCard,
  syncPayment,
  toPaymentView,
} from '../services/payment.service';
import {
  getOrCreateWallet,
  idTagsForWallet,
  isInternalDriver,
  listEntries,
  toWalletView,
  type WalletOwner,
} from '../services/wallet.service';
import { HttpError } from '../lib/errors';
import { DriverError, notFound } from './http';

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
  /** False when QPay is switched off — the QR top-up has to be hidden. */
  topUpEnabled: boolean;
  /** Card / SocialPay top-up through Golomt's hosted page. */
  cardTopUpEnabled: boolean;
  /** Cards can be saved on the bank page and charged in one tap later. */
  savedCardsEnabled: boolean;
  /** SocialPay through Golomt: pay in the SocialPay app. */
  socialPayEnabled: boolean;
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
    cardTopUpEnabled: env.GOLOMT_ENABLED,
    savedCardsEnabled: env.GOLOMT_ENABLED && env.GOLOMT_TOKEN_ENABLED,
    socialPayEnabled: env.GOLOMT_ENABLED,
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

/**
 * Opens an invoice that credits the wallet once it is paid: a QPay QR, or a
 * Golomt card page the client sends the driver to (`paymentUrl`).
 */
export async function createTopUp(input: {
  userId: string;
  amount: number;
  description: string;
  receiverCode?: string;
  method?: 'qpay' | 'card' | 'saved_card' | 'socialpay';
  /** card: keep the card for one-tap top-ups once paid. */
  saveCard?: boolean;
  /** saved_card: which of the driver's saved cards to charge. */
  cardId?: string;
}): Promise<Record<string, unknown>> {
  const owner = ownerFor(input.userId);
  // The wallet has to exist before the payment settles and credits it.
  await getOrCreateWallet(owner);
  const golomtInput = {
    amount: input.amount,
    description: input.description,
    userId: input.userId,
    walletOwnerType: owner.ownerType,
    walletOwnerId: owner.ownerId,
  };

  if (input.method === 'card' || input.method === 'saved_card' || input.method === 'socialpay') {
    try {
      const payment =
        input.method === 'saved_card'
          ? await payGolomtTopUpWithCard({ ...golomtInput, cardId: input.cardId ?? '' })
          : await createGolomtTopUp({
              ...golomtInput,
              saveCard: input.method === 'card' && input.saveCard,
              channel: input.method === 'socialpay' ? 'SOCIALPAY' : 'CARD',
            });
      return toDriverView(payment);
    } catch (err) {
      // The bank's own errors are logged in English; the driver gets one line.
      if (err instanceof HttpError && err.message.startsWith('Golomt:')) {
        throw new DriverError(
          502,
          'Банкны системтэй холбогдож чадсангүй. Түр хүлээгээд дахин оролдоно уу.',
        );
      }
      throw err;
    }
  }

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

/**
 * The payment as a driver sees it. A declined card carries the bank's own
 * reason (in Mongolian) as `declineReason`; internal errors stay internal.
 */
export function toDriverView(payment: Parameters<typeof toPaymentView>[0]): Record<string, unknown> {
  const view = toPaymentView(payment);
  const lastError = typeof view.lastError === 'string' ? view.lastError : '';
  if (view.provider === 'GOLOMT' && view.status === 'FAILED') {
    const bankReason = /^\d{3}: (.+)$/.exec(lastError)?.[1];
    view.declineReason = bankReason ?? 'Картын төлбөр амжилтгүй боллоо';
  }
  delete view.lastError;
  return view;
}

/** The driver's saved cards (empty when saved cards are switched off). */
export const getSavedCards = listSavedCards;
export const removeSavedCard = deleteSavedCard;

/** The invoice as stored, or null for an unknown or malformed id. */
export async function getTopUp(paymentId: string): Promise<Record<string, unknown> | null> {
  const payment = await Payment.findById(paymentId)
    .lean()
    .catch(() => null);
  return payment ? toDriverView(payment) : null;
}

/** Asks QPay whether the invoice is paid — the call that credits the wallet. */
export async function checkTopUp(paymentId: string): Promise<Record<string, unknown>> {
  const payment = await Payment.findById(paymentId).select('+callbackSecret');
  if (!payment) throw notFound('Нэхэмжлэх олдсонгүй');
  return toDriverView(await syncPayment(payment));
}

import type { Types } from 'mongoose';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { cpIdFor } from '../lib/chargePointRef';
import {
  env,
  qpayCallbackUrl,
  qpayInvoiceCode,
  qpayQuickQrBankAccount,
} from '../config/env';
import {
  HttpError,
  badRequest,
  conflict,
  notFound,
  serviceUnavailable,
  unauthorized,
} from '../lib/errors';
import {
  Payment,
  type PaymentDoc,
  type PaymentPurpose,
  type PaymentStatus,
} from '../models/Payment';
import type { WalletOwnerType } from '../models/Wallet';
import { Transaction } from '../models/Transaction';
import { bus } from '../realtime/events';
import { QpayError, qpayLogger } from './qpay/http';
import * as merchant from './qpay/merchant.client';
import * as quickqr from './qpay/quickqr.client';
import { credit as creditWallet, debit as debitWallet } from './wallet.service';
import { issueEBarimtForTransaction, issueEBarimtForPayment } from './ebarimt.service';

/** MNT has no subunits in practice — QPay expects whole tugrik. */
const normaliseAmount = (amount: number): number => {
  const rounded = Math.round(amount);
  if (!Number.isFinite(rounded) || rounded <= 0) {
    throw badRequest('Payment amount must be a positive number');
  }
  return rounded;
};

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

type Provider = 'QPAY' | 'QPAY_QUICKQR';

function assertEnabled(): void {
  if (!env.QPAY_ENABLED) throw serviceUnavailable('QPay integration is disabled (QPAY_ENABLED=false)');
  if (!env.QPAY_USERNAME || !env.QPAY_PASSWORD) {
    throw serviceUnavailable('QPay credentials are not configured');
  }
}

/**
 * Which QPay API an invoice goes through. QuickQR needs a terminal and a
 * sub-merchant; the merchant API needs its own credentials and an invoice code.
 */
function resolveProvider(input: { quickQrMerchantId?: string }): Provider {
  if (input.quickQrMerchantId) return 'QPAY_QUICKQR';
  return env.QPAY_DEFAULT_PROVIDER === 'quickqr' ? 'QPAY_QUICKQR' : 'QPAY';
}

function assertQuickQrReady(merchantId: string | undefined): string {
  if (!env.QPAY_QUICKQR_ENABLED) {
    throw serviceUnavailable('QuickQR is disabled (QPAY_QUICKQR_ENABLED=false)');
  }
  if (!env.QPAY_QUICKQR_TERMINAL_ID?.trim()) {
    throw serviceUnavailable('QPAY_QUICKQR_TERMINAL_ID is not configured');
  }
  const resolved = merchantId ?? env.QPAY_QUICKQR_MERCHANT_ID?.trim();
  if (!resolved) {
    throw serviceUnavailable(
      'No QuickQR merchant: set QPAY_QUICKQR_MERCHANT_ID or pass quickQrMerchantId',
    );
  }
  return resolved;
}

/** Map a QpayError onto our HTTP error shape without leaking QPay internals. */
function rethrow(err: unknown, context: string): never {
  if (err instanceof QpayError) {
    qpayLogger.warn({ context, status: err.status, message: err.message }, 'qpay call failed');
    // Never surface a 401 as a 401 to our client — it is our credential problem, not theirs.
    throw new HttpError(
      err.status === 401 || err.status === 403 ? 502 : err.status,
      `QPay: ${err.message}`,
    );
  }
  throw err;
}

export interface CreatePaymentInput {
  amount?: number;
  description?: string;
  /** Our reference; generated when omitted. Reusing one returns the existing invoice. */
  senderInvoiceNo?: string;
  /** Who is paying — QPay's invoice_receiver_code (customer id, phone, or 'terminal'). */
  receiverCode?: string;
  receiver?: { register?: string; name?: string; email?: string; phone?: string };
  transactionId?: number;
  chargePointId?: Types.ObjectId;
  connectorId?: number;
  idTag?: string;
  userId?: string;
  /** What the invoice is for; WALLET_TOPUP credits a wallet once it settles. */
  purpose?: PaymentPurpose;
  /** Wallet a WALLET_TOPUP invoice credits. Required when purpose is WALLET_TOPUP. */
  walletOwnerType?: WalletOwnerType;
  walletOwnerId?: string;
  /** Optional QuickQR sub-merchant to bill through instead of the main merchant. */
  quickQrMerchantId?: string;
  bankAccounts?: quickqr.QuickQrBankAccount[];
  lines?: merchant.QpayInvoiceLine[];
  expiryMinutes?: number;
}

/** Public projection: everything a client needs to render the QR, nothing secret. */
export function toPaymentView(p: PaymentDoc | Record<string, unknown>): Record<string, unknown> {
  const doc = ('toJSON' in p && typeof p.toJSON === 'function' ? p.toJSON() : p) as Record<
    string,
    unknown
  >;
  delete doc.callbackSecret;
  delete doc.qrImage;
  delete doc.__v;
  doc.id = String(doc._id ?? doc.id);
  return doc;
}

/**
 * QuickQR does not use one consistent spelling for the fields of a created
 * invoice — `qr_image` and `urls` come back snake_cased while the id, the QR
 * payload and the short URL have each been seen under several names. Resolve
 * every spelling we have observed rather than binding to one, because a missing
 * `invoice_id` strands the payment: it can never be checked or reconciled.
 */
function pickString(res: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = res[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Create a QPay invoice and the local Payment record that tracks it.
 *
 * The local record is written first so a QPay failure still leaves an auditable
 * trace, and `senderInvoiceNo` is unique — calling this twice with the same
 * reference returns the original invoice instead of double-billing the customer.
 */
export async function createPayment(input: CreatePaymentInput): Promise<PaymentDoc> {
  assertEnabled();

  const purpose: PaymentPurpose = input.purpose ?? 'CHARGING';
  if (purpose === 'WALLET_TOPUP' && !input.walletOwnerId?.trim()) {
    throw badRequest('walletOwnerId is required for a WALLET_TOPUP invoice');
  }

  let amount = input.amount;
  let description = input.description;
  const meta: Partial<CreatePaymentInput> = { ...input };

  if (input.transactionId !== undefined) {
    const tx = await Transaction.findById(input.transactionId).lean();
    if (!tx) throw notFound(`Transaction ${input.transactionId} not found`);
    if (amount === undefined) {
      const derived =
        tx.cost ?? (tx.tariffPerKwh ? ((tx.energyWh ?? 0) / 1000) * tx.tariffPerKwh : undefined);
      if (derived === undefined) {
        throw badRequest(
          `Transaction ${input.transactionId} has no cost or tariffPerKwh; pass an explicit amount`,
        );
      }
      amount = derived;
    }
    // The invoice is read by a person, so it names the station rather than
            // referencing it.
    const cpId = (await cpIdFor(tx.chargePointId)) ?? 'unknown station';
    description ??= `Charging session ${tx._id} at ${cpId} (${((tx.energyWh ?? 0) / 1000).toFixed(
      2,
    )} kWh)`;
    meta.chargePointId = input.chargePointId ?? tx.chargePointId;
    meta.connectorId = input.connectorId ?? tx.connectorId;
    meta.idTag = input.idTag ?? tx.idTag;
  }

  if (amount === undefined) throw badRequest('amount is required');
  const finalAmount = normaliseAmount(amount);
  const finalDescription = (description ?? 'EV charging').slice(0, 255);
  const senderInvoiceNo = (input.senderInvoiceNo ?? `EV-${randomUUID()}`).slice(0, 45);

  const existing = await Payment.findOne({ senderInvoiceNo }).select('+callbackSecret');
  if (existing) {
    if (existing.status === 'PENDING' && existing.invoiceId) return existing;
    if (existing.status !== 'PENDING') {
      throw conflict(`Invoice ${senderInvoiceNo} already exists with status ${existing.status}`);
    }
  }

  const provider = resolveProvider(input);
  const quickQrMerchantId =
    provider === 'QPAY_QUICKQR' ? assertQuickQrReady(input.quickQrMerchantId) : undefined;
  const ttlMinutes = input.expiryMinutes ?? env.QPAY_INVOICE_TTL_MINUTES;
  const callbackSecret = randomBytes(24).toString('base64url');

  const payment =
    existing ??
    new Payment({
      senderInvoiceNo,
      provider,
      status: 'PENDING',
      amount: finalAmount,
      currency: 'MNT',
      description: finalDescription,
      transactionId: input.transactionId,
      chargePointId: meta.chargePointId,
      connectorId: meta.connectorId,
      idTag: meta.idTag,
      userId: input.userId,
      purpose,
      walletOwnerType: purpose === 'WALLET_TOPUP' ? input.walletOwnerType : undefined,
      walletOwnerId: purpose === 'WALLET_TOPUP' ? input.walletOwnerId : undefined,
      merchantId: quickQrMerchantId,
      invoiceReceiverCode: input.receiverCode ?? input.idTag ?? 'terminal',
      callbackSecret,
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
    });

  // A retry of a half-created invoice keeps its original secret so the callback
  // URL QPay ends up with always matches what we stored.
  if (!payment.callbackSecret) payment.callbackSecret = callbackSecret;
  if (!existing) await payment.save();

  const callbackUrl = qpayCallbackUrl(String(payment._id), payment.callbackSecret);

  try {
    if (provider === 'QPAY_QUICKQR') {
      const defaultAccount = qpayQuickQrBankAccount();
      const res = await quickqr.createInvoice({
        merchant_id: quickQrMerchantId!,
        amount: finalAmount,
        currency: 'MNT',
        description: finalDescription,
        mcc_code: env.QPAY_QUICKQR_MCC_CODE?.trim() || undefined,
        callback_url: callbackUrl,
        bank_accounts: input.bankAccounts ?? (defaultAccount ? [defaultAccount] : undefined),
      });
      const raw = res as unknown as Record<string, unknown>;
      const invoiceId = pickString(raw, 'invoice_id', 'invoiceId', 'id');
      if (!invoiceId) {
        // Surface the real shape once; the invoice is unusable without an id.
        qpayLogger.error(
          { keys: Object.keys(raw), senderInvoiceNo },
          'QuickQR createInvoice returned no recognisable invoice id',
        );
      }
      payment.invoiceId = invoiceId;
      payment.qrText = pickString(raw, 'qr_text', 'qrText', 'qPay_QRcode', 'qRcode', 'qrcode');
      payment.qrImage = pickString(raw, 'qr_image', 'qrImage');
      payment.shortUrl = pickString(raw, 'qPay_shortUrl', 'qPay_shorturl', 'short_url', 'shortUrl');
      payment.deeplinks = (res.urls ?? []) as typeof payment.deeplinks;
    } else {
      const res = await merchant.createInvoice({
        invoice_code: qpayInvoiceCode(),
        sender_invoice_no: senderInvoiceNo,
        invoice_receiver_code: payment.invoiceReceiverCode ?? 'terminal',
        invoice_description: finalDescription,
        amount: finalAmount,
        callback_url: callbackUrl,
        enable_expiry: true,
        expiry_date: payment.expiresAt?.toISOString().slice(0, 19).replace('T', ' '),
        invoice_receiver_data: input.receiver,
        lines: input.lines,
      });
      payment.invoiceId = res.invoice_id;
      payment.invoiceCode = qpayInvoiceCode();
      payment.qrText = res.qr_text;
      payment.qrImage = res.qr_image;
      payment.shortUrl = res.qPay_shortUrl;
      payment.deeplinks = (res.urls ?? []) as typeof payment.deeplinks;
    }
  } catch (err) {
    payment.status = 'FAILED';
    payment.lastError = err instanceof Error ? err.message.slice(0, 500) : 'unknown error';
    await payment.save();
    rethrow(err, 'createInvoice');
  }

  payment.lastError = undefined;
  await payment.save();

  bus.emitEvent('payment.created', await cpIdFor(payment.chargePointId), {
    paymentId: String(payment._id),
    senderInvoiceNo,
    invoiceId: payment.invoiceId,
    amount: finalAmount,
    transactionId: payment.transactionId,
  });

  return payment;
}

/**
 * QuickQR settles a payment as `SUCCESS`, where the merchant API says `PAID`.
 * Both mean the money arrived, and `syncPayment` counts a leg as settled only
 * when it reads `PAID` — so normalise before that comparison, or a paid invoice
 * looks unpaid forever.
 */
function normaliseQuickQrStatus(status: string | undefined): string | undefined {
  if (!status) return undefined;
  const upper = status.toUpperCase();
  if (upper === 'SUCCESS' || upper === 'PAID') return 'PAID';
  return upper;
}

/**
 * Credit a settled top-up to its wallet. Keyed on `payment:<id>` so a QPay
 * callback and a reconciliation sweep arriving for the same invoice credit it
 * once. A wallet failure must never roll back a payment QPay has already taken,
 * so this records the error and leaves the money for an operator to apply.
 */
async function applyWalletTopUp(payment: PaymentDoc): Promise<void> {
  if (payment.purpose !== 'WALLET_TOPUP') return;
  if (payment.walletCreditedAt) return;
  if (!payment.walletOwnerId) {
    qpayLogger.error(
      { paymentId: String(payment._id) },
      'settled top-up has no wallet owner; cannot credit',
    );
    return;
  }

  try {
    const movement = await creditWallet(
      {
        ownerType: (payment.walletOwnerType ?? 'USER') as WalletOwnerType,
        ownerId: payment.walletOwnerId,
      },
      payment.paidAmount || payment.amount,
      'TOPUP',
      {
        description: payment.description ?? 'Хэтэвч цэнэглэлт',
        idempotencyKey: `payment:${String(payment._id)}`,
        paymentId: String(payment._id),
        idTag: payment.idTag ?? undefined,
        createdBy: 'qpay',
      },
    );

    payment.walletCreditedAt = new Date();
    payment.walletEntryId = movement.entryId ?? undefined;
    await payment.save();
  } catch (err) {
    payment.lastError = `wallet credit failed: ${
      err instanceof Error ? err.message.slice(0, 400) : 'unknown error'
    }`;
    await payment.save().catch(() => undefined);
    qpayLogger.error(
      { paymentId: String(payment._id), err: (err as Error).message },
      'failed to credit wallet for settled top-up',
    );
  }
}

/**
 * Ask QPay what it knows about an invoice and reconcile our record with it.
 * This is the single source of truth for a payment's status — callbacks and
 * client polling both funnel through here, so a spoofed callback changes nothing.
 */
export async function syncPayment(payment: PaymentDoc): Promise<PaymentDoc> {
  assertEnabled();
  if (!payment.invoiceId) throw badRequest('Payment has no QPay invoice yet');

  let paidAmount = 0;
  let rows: {
    paymentId: string;
    status?: string;
    amount: number;
    currency?: string;
    paymentWallet?: string;
    paymentType?: string;
    transactionType?: string;
    paidAt?: Date;
  }[] = [];

  try {
    if (payment.provider === 'QPAY_QUICKQR') {
      const res = await quickqr.checkPayment(payment.invoiceId);

      // QuickQR reports under `payments`; the merchant-API `rows` spelling is
      // accepted as a fallback so either shape parses.
      rows = (res.payments ?? []).map((r) => ({
        paymentId: String(r.id ?? ''),
        status: normaliseQuickQrStatus(r.payment_status),
        // The gross amount the customer paid. The nested `transactions[].amount`
        // is the NET after QPay's fee — crediting that would short the driver.
        amount: num(r.amount),
        currency: r.currency ?? 'MNT',
        paymentWallet: r.wallet_customer_id,
        transactionType: r.paid_by,
        paidAt: r.payment_status_date ? new Date(r.payment_status_date) : undefined,
      }));

      if (rows.length === 0 && res.rows?.length) {
        rows = res.rows.map((r) => ({
          paymentId: String(r.payment_id ?? ''),
          status: normaliseQuickQrStatus(r.payment_status),
          amount: num(r.payment_amount),
          currency: r.payment_currency ?? 'MNT',
          paymentWallet: r.payment_wallet,
          transactionType: r.transaction_type,
          paidAt: r.payment_date ? new Date(r.payment_date) : undefined,
        }));
      }

      // QuickQR sends no `paid_amount`; the settled legs are the only total.
      paidAmount = num(res.paid_amount);

      if (rows.length === 0 && res.invoice_status?.toUpperCase() === 'PAID') {
        // The invoice says paid but carried no legs we could read — never treat
        // that as unpaid, and leave the evidence for whoever has to reconcile it.
        qpayLogger.warn(
          { invoiceId: payment.invoiceId, response: res },
          'QuickQR reports the invoice PAID but returned no readable payments',
        );
      }
    } else {
      const res = await merchant.checkPayment(payment.invoiceId);
      rows = (res.rows ?? []).map((r) => ({
        paymentId: r.payment_id,
        status: r.payment_status,
        amount: num(r.payment_amount),
        currency: r.payment_currency ?? 'MNT',
        paymentWallet: r.payment_wallet,
        paymentType: r.payment_type,
        transactionType: r.transaction_type,
        paidAt: r.payment_date ? new Date(r.payment_date) : undefined,
      }));
      paidAmount = num(res.paid_amount);
    }
  } catch (err) {
    payment.lastError = err instanceof Error ? err.message.slice(0, 500) : 'unknown error';
    payment.checkedAt = new Date();
    await payment.save();
    rethrow(err, 'checkPayment');
  }

  // Trust the summed PAID rows over paid_amount when they disagree.
  const settled = rows.filter((r) => !r.status || r.status.toUpperCase() === 'PAID');
  const settledTotal = settled.reduce((sum, r) => sum + r.amount, 0);
  const effectivePaid = Math.max(paidAmount, settledTotal);

  const previousStatus = payment.status as PaymentStatus;
  payment.payments = rows as typeof payment.payments;
  payment.paidAmount = effectivePaid;
  payment.checkedAt = new Date();
  payment.checkCount = (payment.checkCount ?? 0) + 1;
  payment.lastError = undefined;

  const refunded = rows.some((r) => r.status?.toUpperCase() === 'REFUNDED');

  if (previousStatus === 'REFUNDED' || (refunded && effectivePaid <= 0)) {
    // A refund can be issued on QPay's side too; never flip such an invoice
    // back to PAID just because the original payment row is still listed.
    payment.status = 'REFUNDED';
  } else if (effectivePaid >= payment.amount) {
    payment.status = 'PAID';
    payment.paidAt ??= settled.find((r) => r.paidAt)?.paidAt ?? new Date();
  } else if (effectivePaid > 0) {
    payment.status = 'PARTIALLY_PAID';
  } else if (
    payment.status === 'PENDING' &&
    payment.expiresAt &&
    payment.expiresAt.getTime() < Date.now()
  ) {
    payment.status = 'EXPIRED';
  }

  try {
    await payment.save();
  } catch (err: any) {
    if (err.name === 'VersionError') {
      const fresh = await Payment.findById(payment._id);
      if (fresh) {
        payment = fresh;
      }
    } else {
      throw err;
    }
  }

  if (payment.status === 'PAID' && previousStatus !== 'PAID') {
    if (payment.transactionId !== undefined && payment.transactionId !== null) {
      await Transaction.updateOne(
        { _id: payment.transactionId },
        { $set: { cost: payment.paidAmount } },
      ).catch(() => undefined);

      await issueEBarimtForTransaction(payment.transactionId).catch((err: unknown) =>
        qpayLogger.error(
          { paymentId: String(payment._id), err: (err as Error).message },
          'failed to issue ebarimt after QPay transaction payment',
        ),
      );
    } else {
      await issueEBarimtForPayment(payment).catch((err: unknown) =>
        qpayLogger.error(
          { paymentId: String(payment._id), err: (err as Error).message },
          'failed to issue ebarimt after QPay wallet topup',
        ),
      );
    }

    await applyWalletTopUp(payment);
    bus.emitEvent('payment.paid', await cpIdFor(payment.chargePointId), {
      paymentId: String(payment._id),
      senderInvoiceNo: payment.senderInvoiceNo,
      invoiceId: payment.invoiceId,
      amount: payment.amount,
      paidAmount: payment.paidAmount,
      transactionId: payment.transactionId,
      idTag: payment.idTag,
    });
    qpayLogger.info(
      { paymentId: String(payment._id), invoiceId: payment.invoiceId, paidAmount: payment.paidAmount },
      'payment settled',
    );
  }

  return payment;
}

/** Timing-safe comparison of two callback secrets. */
function secretMatches(expected: string | null | undefined, provided: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Handle a QPay callback. The URL secret only decides whether we bother calling
 * QPay; the payment state itself always comes from `syncPayment`.
 */
export async function handleCallback(
  paymentId: string,
  secret: string,
  staticToken: string | undefined,
): Promise<PaymentDoc> {
  const configuredToken = env.QPAY_CALLBACK_TOKEN?.trim();
  if (configuredToken && !secretMatches(configuredToken, staticToken ?? '')) {
    throw unauthorized('Invalid callback token');
  }

  const payment = await Payment.findById(paymentId).select('+callbackSecret');
  if (!payment) throw notFound('Payment not found');
  if (!secretMatches(payment.callbackSecret, secret)) throw unauthorized('Invalid callback secret');

  payment.callbackAt = new Date();
  payment.callbackCount = (payment.callbackCount ?? 0) + 1;
  await payment.save();

  return syncPayment(payment);
}

/** Cancel an unpaid invoice on QPay and locally. */
export async function cancelPayment(payment: PaymentDoc): Promise<PaymentDoc> {
  assertEnabled();
  if (payment.status === 'PAID') throw conflict('A paid invoice cannot be canceled; refund it instead');

  if (payment.invoiceId) {
    try {
      if (payment.provider === 'QPAY_QUICKQR') await quickqr.cancelInvoice(payment.invoiceId);
      else await merchant.cancelInvoice(payment.invoiceId);
    } catch (err) {
      // A 404 from QPay means it is already gone — that is still "canceled" for us.
      if (!(err instanceof QpayError && err.status === 404)) rethrow(err, 'cancelInvoice');
    }
  }

  payment.status = 'CANCELED';
  payment.canceledAt = new Date();
  await payment.save();

  bus.emitEvent('payment.canceled', await cpIdFor(payment.chargePointId), {
    paymentId: String(payment._id),
    senderInvoiceNo: payment.senderInvoiceNo,
  });

  return payment;
}

/** Refund a settled payment leg. */
export async function refundPayment(payment: PaymentDoc, note?: string): Promise<PaymentDoc> {
  assertEnabled();
  if (payment.status !== 'PAID') throw conflict('Only a PAID invoice can be refunded');
  if (payment.provider === 'QPAY_QUICKQR') {
    throw conflict('QuickQR invoices cannot be refunded through the API; refund them in QPay');
  }
  const leg = payment.payments?.find((p) => !p.status || p.status.toUpperCase() === 'PAID');
  if (!leg) throw conflict('No settled QPay payment to refund');

  try {
    await merchant.refundPayment(leg.paymentId, note);
  } catch (err) {
    rethrow(err, 'refundPayment');
  }

  payment.status = 'REFUNDED';
  await payment.save();

  // A refunded top-up must take the credited money back out of the wallet, or
  // the driver keeps a balance QPay has already returned to them.
  if (payment.purpose === 'WALLET_TOPUP' && payment.walletCreditedAt && payment.walletOwnerId) {
    await debitWallet(
      {
        ownerType: (payment.walletOwnerType ?? 'USER') as WalletOwnerType,
        ownerId: payment.walletOwnerId,
      },
      payment.paidAmount || payment.amount,
      'ADJUSTMENT',
      {
        description: 'Цэнэглэлт буцаагдсан',
        idempotencyKey: `payment-refund:${String(payment._id)}`,
        paymentId: String(payment._id),
        createdBy: 'qpay',
      },
      { allowNegative: true },
    ).catch((err: unknown) =>
      qpayLogger.error(
        { paymentId: String(payment._id), err: (err as Error).message },
        'failed to reverse wallet credit for refunded top-up',
      ),
    );
  }

  return payment;
}

/**
 * Reconcile invoices that are still pending — the safety net for callbacks QPay
 * never delivered. Called by the maintenance loop and the admin sync endpoint.
 */
export async function reconcilePendingPayments(limit = 50): Promise<{
  checked: number;
  paid: number;
  expired: number;
}> {
  if (!env.QPAY_ENABLED) return { checked: 0, paid: 0, expired: 0 };

  const pending = await Payment.find({
    status: { $in: ['PENDING', 'PARTIALLY_PAID'] },
    invoiceId: { $ne: null },
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .select('+callbackSecret');

  let paid = 0;
  let expired = 0;

  for (const payment of pending) {
    try {
      const updated = await syncPayment(payment);
      if (updated.status === 'PAID') paid += 1;
      if (updated.status === 'EXPIRED') expired += 1;
    } catch (err) {
      qpayLogger.warn(
        { paymentId: String(payment._id), err: (err as Error).message },
        'payment reconciliation failed',
      );
    }
  }

  return { checked: pending.length, paid, expired };
}

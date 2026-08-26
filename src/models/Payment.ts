import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { WALLET_OWNER_TYPES } from './Wallet';

export const PAYMENT_PROVIDERS = ['QPAY', 'QPAY_QUICKQR'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

/**
 * What the invoice is for. `CHARGING` bills a session directly; `WALLET_TOPUP`
 * credits a prepaid wallet once QPay settles it.
 */
export const PAYMENT_PURPOSES = ['CHARGING', 'WALLET_TOPUP'] as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

export const PAYMENT_STATUSES = [
  'PENDING',
  'PARTIALLY_PAID',
  'PAID',
  'CANCELED',
  'EXPIRED',
  'REFUNDED',
  'FAILED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** One settled (or attempted) payment QPay reports against an invoice. */
const qpayPaymentSchema = new Schema(
  {
    paymentId: { type: String, required: true },
    status: { type: String }, // NEW | FAILED | PAID | REFUNDED
    amount: { type: Number, default: 0 },
    currency: { type: String, default: 'MNT' },
    paymentWallet: { type: String },
    paymentType: { type: String },
    transactionType: { type: String },
    paidAt: { type: Date },
  },
  { _id: false },
);

const paymentSchema = new Schema(
  {
    /** Our own reference, sent to QPay as sender_invoice_no. Unique = idempotency key. */
    senderInvoiceNo: { type: String, required: true, unique: true },
    provider: { type: String, enum: PAYMENT_PROVIDERS, default: 'QPAY', index: true },
    purpose: { type: String, enum: PAYMENT_PURPOSES, default: 'CHARGING', index: true },
    status: { type: String, enum: PAYMENT_STATUSES, default: 'PENDING', index: true },

    /** QPay side identifiers. */
    invoiceId: { type: String, index: true, sparse: true },
    invoiceCode: { type: String },
    merchantId: { type: String }, // QuickQR sub-merchant, when applicable

    amount: { type: Number, required: true },
    paidAmount: { type: Number, default: 0 },
    currency: { type: String, default: 'MNT' },
    description: { type: String, required: true },

    /** What is being paid for. */
    transactionId: { type: Number, index: true, sparse: true }, // OCPP transaction
    chargePointId: { type: Schema.Types.ObjectId, ref: 'ChargePoint', index: true },
    connectorId: { type: Number },
    idTag: { type: String, index: true },
    userId: { type: String },
    invoiceReceiverCode: { type: String },

    /** Wallet a WALLET_TOPUP invoice credits, and when the credit was applied. */
    walletOwnerType: { type: String, enum: WALLET_OWNER_TYPES },
    walletOwnerId: { type: String, index: true, sparse: true },
    walletCreditedAt: { type: Date },
    walletEntryId: { type: String },

    /** Payment artefacts handed to the client so it can render the QR. */
    qrText: { type: String },
    qrImage: { type: String, select: false }, // base64 PNG, fetched only on demand
    shortUrl: { type: String },
    deeplinks: {
      type: [
        new Schema(
          {
            name: { type: String },
            description: { type: String },
            logo: { type: String },
            link: { type: String },
          },
          { _id: false },
        ),
      ],
      default: [],
    },

    payments: { type: [qpayPaymentSchema], default: [] },

    /** Per-invoice callback secret; verified in constant time, never returned. */
    callbackSecret: { type: String, select: false },
    callbackCount: { type: Number, default: 0 },
    callbackAt: { type: Date },
    checkedAt: { type: Date },
    checkCount: { type: Number, default: 0 },
    paidAt: { type: Date },
    canceledAt: { type: Date },
    expiresAt: { type: Date, index: true },
    lastError: { type: String },

    ebarimt: {
      receiptId: { type: String },
      type: { type: String, enum: ['B2C_RECEIPT', 'B2B_RECEIPT'] },
      qrData: { type: String },
      lottery: { type: String },
      merchantTin: { type: String },
      customerNo: { type: String },
      customerTin: { type: String },
      totalAmount: { type: Number },
      totalVAT: { type: Number },
      status: { type: String, enum: ['SUCCESS', 'FAILED', 'PENDING'] },
      issuedAt: { type: Date },
      error: { type: String },
      rawResponse: { type: Schema.Types.Mixed },
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = String(ret._id);
        delete ret.callbackSecret;
        delete ret.__v;
        return ret;
      },
    },
  },
);

paymentSchema.index({ status: 1, expiresAt: 1 });
paymentSchema.index({ createdAt: -1 });

export type PaymentAttrs = InferSchemaType<typeof paymentSchema>;
export type PaymentDoc = HydratedDocument<PaymentAttrs>;

export const Payment = model('Payment', paymentSchema);

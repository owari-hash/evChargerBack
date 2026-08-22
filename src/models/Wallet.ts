import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * Prepaid wallets.
 *
 * A wallet belongs to a generic owner so the same balance machinery serves both
 * front ends: `IDTAG` wallets are keyed by the RFID card presented at a charger
 * (no account needed), `USER` wallets by a driver account in the web app. An
 * idTag can point at a user's wallet via `IdTag.walletOwner*`, which is how one
 * balance ends up covering every card a driver owns.
 *
 * Money is stored as whole tugrik. MNT has no subunits in practice and QPay only
 * ever settles integers, so there is nothing to lose and no float to round.
 */

export const WALLET_OWNER_TYPES = ['USER', 'IDTAG'] as const;
export type WalletOwnerType = (typeof WALLET_OWNER_TYPES)[number];

export const WALLET_STATUSES = ['ACTIVE', 'FROZEN'] as const;
export type WalletStatus = (typeof WALLET_STATUSES)[number];

/**
 * Ledger entry kinds. `TOPUP` and `BONUS` credit, `CHARGE` debits, `REFUND`
 * credits back a charge, and `ADJUSTMENT` is a manual operator correction that
 * may go either way.
 */
export const WALLET_ENTRY_TYPES = ['TOPUP', 'CHARGE', 'REFUND', 'ADJUSTMENT', 'BONUS'] as const;
export type WalletEntryType = (typeof WALLET_ENTRY_TYPES)[number];

const walletSchema = new Schema(
  {
    ownerType: { type: String, enum: WALLET_OWNER_TYPES, required: true },
    /** Driver account id for USER, the idTag itself for IDTAG. */
    ownerId: { type: String, required: true },

    balance: { type: Number, default: 0 },
    currency: { type: String, default: 'MNT' },
    status: { type: String, enum: WALLET_STATUSES, default: 'ACTIVE', index: true },

    /** Lifetime totals, kept denormalised so the account screen needs one read. */
    totalToppedUp: { type: Number, default: 0 },
    totalSpent: { type: Number, default: 0 },

    /** Human label shown in the operator console (owner name, card label…). */
    label: { type: String },
    note: { type: String },

    lastTopUpAt: { type: Date },
    lastSpendAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = String(ret._id);
        delete ret.__v;
        return ret;
      },
    },
  },
);

/** One wallet per owner — also the lookup every read goes through. */
walletSchema.index({ ownerType: 1, ownerId: 1 }, { unique: true });

export type WalletAttrs = InferSchemaType<typeof walletSchema>;
export type WalletDoc = HydratedDocument<WalletAttrs>;

export const Wallet = model('Wallet', walletSchema);

/**
 * Append-only ledger. Every balance change writes one entry, so the balance on
 * the wallet is always reproducible by summing `amount` over its entries.
 */
const walletEntrySchema = new Schema(
  {
    walletId: { type: Schema.Types.ObjectId, ref: 'Wallet', required: true, index: true },
    ownerType: { type: String, enum: WALLET_OWNER_TYPES, required: true },
    ownerId: { type: String, required: true, index: true },

    type: { type: String, enum: WALLET_ENTRY_TYPES, required: true, index: true },
    /** Signed: positive credits the wallet, negative debits it. */
    amount: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    currency: { type: String, default: 'MNT' },
    description: { type: String },

    /**
     * Guards against double-crediting. A settled QPay invoice writes
     * `payment:<paymentId>` and a closed session `transaction:<transactionId>`,
     * so replaying a callback or a reconciliation sweep is a no-op.
     */
    idempotencyKey: { type: String, unique: true, sparse: true },

    /** What the entry refers to; all optional, set for the kinds that have one. */
    paymentId: { type: String, index: true, sparse: true },
    transactionId: { type: Number, index: true, sparse: true },
    chargePointId: { type: Schema.Types.ObjectId, ref: 'ChargePoint' },
    connectorId: { type: Number },
    idTag: { type: String },
    /** Who performed a manual adjustment (user id or 'system'). */
    createdBy: { type: String },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = String(ret._id);
        delete ret.__v;
        return ret;
      },
    },
  },
);

walletEntrySchema.index({ walletId: 1, createdAt: -1 });
walletEntrySchema.index({ ownerType: 1, ownerId: 1, createdAt: -1 });

export type WalletEntryAttrs = InferSchemaType<typeof walletEntrySchema>;
export type WalletEntryDoc = HydratedDocument<WalletEntryAttrs>;

export const WalletEntry = model('WalletEntry', walletEntrySchema);

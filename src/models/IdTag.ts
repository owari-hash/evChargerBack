import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { AUTHORIZATION_STATUSES } from './enums';
import { WALLET_OWNER_TYPES } from './Wallet';

const idTagSchema = new Schema(
  {
    _id: { type: String, required: true }, // the idTag itself
    parentIdTag: { type: String },
    status: { type: String, enum: AUTHORIZATION_STATUSES, default: 'Accepted', index: true },
    expiryDate: { type: Date },
    label: { type: String },
    ownerName: { type: String },
    ownerEmail: { type: String },
    // How many transactions this tag may have running at once (0 = unlimited)
    maxActiveTransactions: { type: Number, default: 1 },
    // Optional whitelist: if non-empty the tag is only valid at these charge points
    /** Restricts the tag to these charge points; empty means anywhere. Stored
     *  as references so renaming a station cannot silently widen or void it. */
    allowedChargePointIds: { type: [{ type: Schema.Types.ObjectId, ref: 'ChargePoint' }], default: [] },
    note: { type: String },

    /**
     * Which prepaid wallet this tag spends from. Unset means the tag's own
     * wallet (`IDTAG` / the idTag itself); pointing it at a `USER` wallet lets
     * every card a driver owns draw on one account balance.
     */
    walletOwnerType: { type: String, enum: WALLET_OWNER_TYPES },
    walletOwnerId: { type: String, index: true, sparse: true },
  },
  {
    timestamps: true,
    _id: false,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        ret.idTag = ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

export type IdTagAttrs = InferSchemaType<typeof idTagSchema>;
export type IdTagDoc = HydratedDocument<IdTagAttrs>;

export const IdTag = model('IdTag', idTagSchema);

const localAuthEntrySchema = new Schema(
  {
    chargePointId: { type: Schema.Types.ObjectId, ref: 'ChargePoint', required: true, index: true },
    idTag: { type: String, required: true },
    status: { type: String, enum: AUTHORIZATION_STATUSES, default: 'Accepted' },
    parentIdTag: { type: String },
    expiryDate: { type: Date },
    listVersion: { type: Number, default: 0 },
  },
  { timestamps: true },
);

localAuthEntrySchema.index({ chargePointId: 1, idTag: 1 }, { unique: true });

export type LocalAuthListEntryAttrs = InferSchemaType<typeof localAuthEntrySchema>;
export const LocalAuthListEntry = model('LocalAuthListEntry', localAuthEntrySchema);

/** Tracks the local authorization list version currently held by each charge point. */
const localListVersionSchema = new Schema(
  {
    chargePointId: {
      type: Schema.Types.ObjectId,
      ref: 'ChargePoint',
      required: true,
      unique: true,
      index: true,
    },
    version: { type: Number, default: 0 },
    lastSyncedAt: { type: Date },
  },
  { timestamps: true },
);

export const LocalListVersion = model('LocalListVersion', localListVersionSchema);

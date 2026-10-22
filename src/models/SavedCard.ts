import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * A driver's bank card saved for one-tap top-ups (Golomt card token).
 *
 * The token lets us charge the card, so it is stored only encrypted
 * (`tokenEnc`, AES-256-GCM) and never selected by default. `tokenHash` lets a
 * card paid with twice dedupe to one row without decrypting anything. The card
 * number is the bank's masked form, e.g. 515023******7733.
 */
const savedCardSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    provider: { type: String, enum: ['GOLOMT'], default: 'GOLOMT' },
    tokenEnc: { type: String, required: true, select: false },
    tokenHash: { type: String, required: true },
    cardNumber: { type: String },
    cardHolder: { type: String },
    bank: { type: String },
    lastUsedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.tokenEnc;
        delete ret.tokenHash;
        delete ret.__v;
        return ret;
      },
    },
  },
);

savedCardSchema.index({ userId: 1, tokenHash: 1 }, { unique: true });

export type SavedCardAttrs = InferSchemaType<typeof savedCardSchema>;
export type SavedCardDoc = HydratedDocument<SavedCardAttrs>;

export const SavedCard = model('SavedCard', savedCardSchema);

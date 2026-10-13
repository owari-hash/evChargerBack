import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * A payout from Eplug to a client (Харилцагч). Drivers' money lands in Eplug's
 * QPay account; each session at a client's station earns that client its cost
 * minus Eplug's fee, and these records are what has been paid out against it.
 */
const settlementSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    amount: { type: Number, required: true },
    /** The sessions period this payout covers, for the report. Informational. */
    periodFrom: { type: Date },
    periodTo: { type: Date },
    /** Bank transfer reference. */
    reference: { type: String, trim: true },
    note: { type: String, trim: true },
    paidAt: { type: Date, default: () => new Date(), index: true },
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

export type SettlementAttrs = InferSchemaType<typeof settlementSchema>;
export type SettlementDoc = HydratedDocument<SettlementAttrs>;

export const Settlement = model('Settlement', settlementSchema);

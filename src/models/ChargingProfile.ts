import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const chargingProfileSchema = new Schema(
  {
    chargePointId: { type: String, required: true, index: true },
    connectorId: { type: Number, required: true },
    chargingProfileId: { type: Number, required: true },
    transactionId: { type: Number },
    stackLevel: { type: Number, required: true },
    chargingProfilePurpose: {
      type: String,
      enum: ['ChargePointMaxProfile', 'TxDefaultProfile', 'TxProfile'],
      required: true,
    },
    chargingProfileKind: {
      type: String,
      enum: ['Absolute', 'Recurring', 'Relative'],
      required: true,
    },
    recurrencyKind: { type: String, enum: ['Daily', 'Weekly', null] },
    validFrom: { type: Date },
    validTo: { type: Date },
    // Raw OCPP ChargingSchedule object, stored verbatim so it can be replayed
    chargingSchedule: { type: Schema.Types.Mixed, required: true },
    isActive: { type: Boolean, default: true, index: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

chargingProfileSchema.index({ chargePointId: 1, chargingProfileId: 1 }, { unique: true });

export type ChargingProfileAttrs = InferSchemaType<typeof chargingProfileSchema>;
export type ChargingProfileDoc = HydratedDocument<ChargingProfileAttrs>;

export const ChargingProfile = model('ChargingProfile', chargingProfileSchema);

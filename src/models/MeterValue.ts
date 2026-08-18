import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const sampledValueSchema = new Schema(
  {
    value: { type: String, required: true },
    numericValue: { type: Number },
    context: { type: String },
    format: { type: String },
    measurand: { type: String, default: 'Energy.Active.Import.Register' },
    phase: { type: String },
    location: { type: String },
    unit: { type: String },
  },
  { _id: false },
);

const meterValueSchema = new Schema(
  {
    chargePointId: { type: String, required: true, index: true },
    connectorId: { type: Number, required: true },
    transactionId: { type: Number, default: null, index: true },
    timestamp: { type: Date, required: true },
    sampledValue: { type: [sampledValueSchema], default: [] },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

meterValueSchema.index({ chargePointId: 1, timestamp: -1 });
meterValueSchema.index({ transactionId: 1, timestamp: 1 });

export type MeterValueAttrs = InferSchemaType<typeof meterValueSchema>;
export type MeterValueDoc = HydratedDocument<MeterValueAttrs>;

export const MeterValue = model('MeterValue', meterValueSchema);

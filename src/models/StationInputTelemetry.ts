import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const stationInputTelemetrySchema = new Schema(
  {
    chargePointId: { type: Schema.Types.ObjectId, ref: 'ChargePoint', required: true, index: true },
    cpId: { type: String, required: true, index: true },
    timestamp: { type: Date, required: true, index: true },
    inputPowerKW: { type: Number, required: true },
    inputEnergyKWh: { type: Number },
    voltageV: { type: Number },
    currentA: { type: Number },
    frequencyHz: { type: Number },
    powerFactor: { type: Number },
    auxiliaryPowerKW: { type: Number, default: 0 },
    measurementSource: { type: String, default: 'UPSTREAM_METER' },
    qualityStatus: { type: String, enum: ['GOOD', 'STALE', 'SUSPECT'], default: 'GOOD' },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = String(ret._id);
        delete ret.__v;
        return ret;
      },
    },
  },
);

stationInputTelemetrySchema.index({ chargePointId: 1, timestamp: -1 });
stationInputTelemetrySchema.index({ cpId: 1, timestamp: -1 });

export type StationInputTelemetryAttrs = InferSchemaType<typeof stationInputTelemetrySchema>;
export type StationInputTelemetryDoc = HydratedDocument<StationInputTelemetryAttrs>;

export const StationInputTelemetry = model('StationInputTelemetry', stationInputTelemetrySchema);

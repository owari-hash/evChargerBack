import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const vehicleDetectionSchema = new Schema(
  {
    /** Station OCPP ID (e.g. "sss" or "CP-DEMO-001") */
    cpId: { type: String, required: true, index: true },
    chargePointId: { type: Schema.Types.ObjectId, ref: 'ChargePoint', index: true },
    connectorId: { type: Number, default: 1 },

    /** Vehicle Identification Number (17-char or extracted) */
    vin: { type: String, index: true },

    /** Vehicle Model / Brand (e.g. "VW ID.4 Prime", "BYD Atto 3") */
    model: { type: String },

    /** Where this vehicle info was captured */
    source: {
      type: String,
      enum: ['DataTransfer', 'Authorize', 'StartTransaction', 'MeterValues', 'Other'],
      required: true,
      index: true,
    },

    /** Protocol or message label, e.g. "GBT/BRM", "Authorize.idTag" */
    protocolMessage: { type: String },

    /** Battery capacity (kWh or Ah) */
    batteryCapacity: { type: Number },

    /** Initial or current battery SoC % */
    soc: { type: Number },

    /** Max charging power kW */
    maxPowerKw: { type: Number },

    /** Associated transaction ID if active or started */
    transactionId: { type: Number, index: true },

    /** Remote IP address of the charging station */
    remoteAddress: { type: String },

    /** Exact raw payload or string received from the station */
    rawPayload: { type: Schema.Types.Mixed },

    detectedAt: { type: Date, default: Date.now, index: true },
  },
  {
    timestamps: true,
  },
);

vehicleDetectionSchema.index({ cpId: 1, detectedAt: -1 });
vehicleDetectionSchema.index({ vin: 1, detectedAt: -1 });

export type VehicleDetectionAttrs = InferSchemaType<typeof vehicleDetectionSchema>;
export type VehicleDetectionDoc = HydratedDocument<VehicleDetectionAttrs>;

export const VehicleDetection = model('VehicleDetection', vehicleDetectionSchema);

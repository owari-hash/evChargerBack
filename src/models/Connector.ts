import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { CONNECTOR_STATUSES, CHARGE_POINT_ERROR_CODES } from './enums';

const connectorSchema = new Schema(
  {
    chargePointId: { type: String, required: true, index: true },
    // connectorId 0 refers to the charge point as a whole
    connectorId: { type: Number, required: true, min: 0 },
    status: { type: String, enum: CONNECTOR_STATUSES, default: 'Available' },
    errorCode: { type: String, enum: CHARGE_POINT_ERROR_CODES, default: 'NoError' },
    info: { type: String },
    vendorId: { type: String },
    vendorErrorCode: { type: String },
    statusTimestamp: { type: Date },
    // Reflects the last accepted ChangeAvailability
    availability: { type: String, enum: ['Operative', 'Inoperative'], default: 'Operative' },
    currentTransactionId: { type: Number, default: null },
    lastMeterWh: { type: Number },
    lastPowerW: { type: Number },
    lastSocPercent: { type: Number },
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

connectorSchema.index({ chargePointId: 1, connectorId: 1 }, { unique: true });

export type ConnectorAttrs = InferSchemaType<typeof connectorSchema>;
export type ConnectorDoc = HydratedDocument<ConnectorAttrs>;

export const Connector = model('Connector', connectorSchema);

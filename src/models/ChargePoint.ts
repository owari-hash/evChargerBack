import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { REGISTRATION_STATUSES } from './enums';

const chargePointSchema = new Schema(
  {
    // The OCPP chargePointId taken from the WebSocket connect URL. Used as _id.
    _id: { type: String, required: true },

    name: { type: String },
    description: { type: String },

    // Reported in BootNotification.req
    chargePointVendor: { type: String },
    chargePointModel: { type: String },
    chargePointSerialNumber: { type: String },
    chargeBoxSerialNumber: { type: String },
    firmwareVersion: { type: String },
    iccid: { type: String },
    imsi: { type: String },
    meterType: { type: String },
    meterSerialNumber: { type: String },

    // Registration / security
    registrationStatus: { type: String, enum: REGISTRATION_STATUSES, default: 'Accepted' },
    authorizationKeyHash: { type: String, select: false },
    securityProfile: { type: Number, default: 1, min: 0, max: 3 },
    ocppProtocol: { type: String, default: 'ocpp1.6' },
    isEnabled: { type: Boolean, default: true },

    // Live connection state
    isOnline: { type: Boolean, default: false, index: true },
    lastSeenAt: { type: Date },
    lastBootAt: { type: Date },
    lastHeartbeatAt: { type: Date },
    disconnectedAt: { type: Date },
    heartbeatInterval: { type: Number, default: 300 },
    remoteAddress: { type: String },
    numberOfConnectors: { type: Number, default: 0 },

    // Site metadata
    latitude: { type: Number },
    longitude: { type: Number },
    address: { type: String },
    tariffPerKwh: { type: Number },
    tags: { type: [String], default: [] },
  },
  {
    timestamps: true,
    _id: false,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = ret._id;
        delete ret.authorizationKeyHash;
        delete ret.__v;
        return ret;
      },
    },
  },
);

chargePointSchema.index({ lastSeenAt: -1 });

export type ChargePointAttrs = InferSchemaType<typeof chargePointSchema>;
export type ChargePointDoc = HydratedDocument<ChargePointAttrs>;

export const ChargePoint = model('ChargePoint', chargePointSchema);

import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { REGISTRATION_STATUSES } from './enums';

const chargePointSchema = new Schema(
  {
    /**
      * The OCPP identifier taken from the WebSocket connect URL. It is the name
      * the station authenticates with and can be changed by an operator, so it
      * is an ordinary indexed field rather than the primary key — `_id` is a
      * generated ObjectId that nothing outside this collection has to follow.
      */
    cpId: { type: String, required: true, unique: true, index: true },

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
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', default: null, index: true },
    latitude: { type: Number },
    longitude: { type: Number },
    address: { type: String },
    tariffPerKwh: { type: Number },
    /** Overrides the client's / network fee for this station. Unset = inherit. */
    feePercent: { type: Number, min: 0, max: 100 },
    /** Overrides the client's e-barimt merchant for this station. Unset = inherit. */
    ebarimtMerchantId: { type: Schema.Types.ObjectId, ref: 'EbarimtMerchant' },
    tags: { type: [String], default: [] },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = String(ret._id);
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

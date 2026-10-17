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

    /**
     * Path segments the station sent before its identity, e.g. "Baganuur" in
     * /ocpp/Baganuur/6632010600015961. Recorded as a location hint; the pile
     * serial is the identity, so moving a unit to another site keeps its history.
     */
    sitePath: { type: String, trim: true },

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

    /**
     * Set when a pile starts reporting a different serial than it did before,
     * i.e. the hardware behind this identity changed. Almost always a cloned
     * config: two units sharing a URL silently merge into one record and bill
     * to the wrong pile.
     */
    serialMismatch: {
      previousSerial: { type: String },
      reportedSerial: { type: String },
      detectedAt: { type: Date },
    },

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

    // Vehicle information captured from DataTransfer or charger handshake
    lastVehicleInfo: {
      vin: { type: String },
      model: { type: String },
      soc: { type: Number },
      batteryKwh: { type: Number },
      data: { type: Schema.Types.Mixed },
      receivedAt: { type: Date },
    },

    // Site metadata
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', default: null, index: true },
    /**
     * Other clients this station is also visible to, beyond the owner above.
     * Lets a shared site show up on several clients' station lists and feed
     * several clients' internal-member (free-charging) allow-lists, without
     * disturbing `clientId` — which stays the single source for fee and
     * e-barimt-merchant inheritance, since those cannot sensibly fork across
     * several owners.
     */
    linkedClientIds: { type: [{ type: Schema.Types.ObjectId, ref: 'Client' }], default: [] },
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

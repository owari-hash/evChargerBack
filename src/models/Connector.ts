import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { CONNECTOR_STATUSES, CHARGE_POINT_ERROR_CODES, CONNECTOR_TYPES } from './enums';

const connectorSchema = new Schema(
  {
    chargePointId: { type: Schema.Types.ObjectId, ref: 'ChargePoint', required: true, index: true },
    // connectorId 0 refers to the charge point as a whole
    connectorId: { type: Number, required: true, min: 0 },

    /**
     * Short permanent code behind the printed QR sticker — see lib/connectorCode.
     * Minted once for physical connectors (connectorId > 0) and never reissued,
     * because the sticker is already on the charger. Absent on connectorId 0,
     * which is the station as a whole rather than a gun.
     */
    code: { type: String, trim: true, uppercase: true },

    /** Operator-set plug metadata; OCPP 1.6 does not report either of these. */
    connectorType: { type: String, enum: [...CONNECTOR_TYPES, null] },
    powerKw: { type: Number, min: 0 },
    /** Optional human label, e.g. "Зүүн тал" — printed beside the QR. */
    label: { type: String, trim: true },
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
    /**
     * An in-flight RemoteStartTransaction this driver has not yet been
     * confirmed or refused for — set atomically by `remoteStart()` so a
     * second scan of the same QR code, arriving before the station's own
     * StartTransaction.req updates `status`/`currentTransactionId`, is
     * refused instead of also being sent to the station. Cleared as soon as
     * the station answers (accepted, rejected, or a later status/transaction
     * update supersedes it), or once `at` is old enough to be ignored as
     * stale — see PENDING_START_STALE_MS in driver/charging.ts.
     */
    pendingStart: {
      idTag: { type: String },
      at: { type: Date },
    },
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
// Sparse: connectorId 0 rows carry no code, and several of them must coexist.
connectorSchema.index({ code: 1 }, { unique: true, sparse: true });

export type ConnectorAttrs = InferSchemaType<typeof connectorSchema>;
export type ConnectorDoc = HydratedDocument<ConnectorAttrs>;

export const Connector = model('Connector', connectorSchema);

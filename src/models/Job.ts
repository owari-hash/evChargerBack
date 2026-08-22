import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { JOB_KINDS } from './enums';

const statusEntrySchema = new Schema(
  { status: { type: String, required: true }, at: { type: Date, default: Date.now } },
  { _id: false },
);

/** UpdateFirmware / SignedUpdateFirmware jobs and their reported status stream. */
const firmwareJobSchema = new Schema(
  {
    chargePointId: { type: Schema.Types.ObjectId, ref: 'ChargePoint', required: true, index: true },
    kind: { type: String, enum: JOB_KINDS, required: true },
    requestId: { type: Number, index: true },
    location: { type: String, required: true },
    retrieveDate: { type: Date },
    installDate: { type: Date },
    retries: { type: Number },
    retryInterval: { type: Number },
    // Signed firmware update (white paper section 5.21 / 6.7)
    signature: { type: String },
    signingCertificate: { type: String },
    status: { type: String, default: 'Pending' },
    statusHistory: { type: [statusEntrySchema], default: [] },
    issuedBy: { type: String },
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

export type FirmwareJobAttrs = InferSchemaType<typeof firmwareJobSchema>;
export type FirmwareJobDoc = HydratedDocument<FirmwareJobAttrs>;
export const FirmwareJob = model('FirmwareJob', firmwareJobSchema);

/** GetDiagnostics / GetLog jobs. */
const diagnosticsJobSchema = new Schema(
  {
    chargePointId: { type: Schema.Types.ObjectId, ref: 'ChargePoint', required: true, index: true },
    kind: { type: String, enum: JOB_KINDS, required: true },
    requestId: { type: Number, index: true },
    location: { type: String, required: true },
    logType: { type: String, enum: ['DiagnosticsLog', 'SecurityLog', null] },
    oldestTimestamp: { type: Date },
    latestTimestamp: { type: Date },
    retries: { type: Number },
    retryInterval: { type: Number },
    fileName: { type: String },
    status: { type: String, default: 'Pending' },
    statusHistory: { type: [statusEntrySchema], default: [] },
    issuedBy: { type: String },
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

export type DiagnosticsJobAttrs = InferSchemaType<typeof diagnosticsJobSchema>;
export type DiagnosticsJobDoc = HydratedDocument<DiagnosticsJobAttrs>;
export const DiagnosticsJob = model('DiagnosticsJob', diagnosticsJobSchema);

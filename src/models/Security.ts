import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { CERTIFICATE_TYPES, CSR_STATUSES } from './enums';

/** SecurityEventNotification.req — white paper section 5.15 */
const securityEventSchema = new Schema(
  {
    // Optional: a connection rejected before it authenticated has no charge
    // point row to reference, and the identifier it presented is still the
    // security-relevant fact, so `cpId` records it verbatim either way.
    chargePointId: { type: Schema.Types.ObjectId, ref: 'ChargePoint', index: true },
    cpId: { type: String, required: true, index: true },
    type: { type: String, required: true, maxlength: 50, index: true },
    timestamp: { type: Date, required: true },
    techInfo: { type: String, maxlength: 255 },
    isCritical: { type: Boolean, default: false, index: true },
    acknowledged: { type: Boolean, default: false },
    acknowledgedBy: { type: String },
    acknowledgedAt: { type: Date },
    // Set for events raised by the Central System itself rather than reported by a charge point
    source: { type: String, enum: ['ChargePoint', 'CentralSystem'], default: 'ChargePoint' },
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

securityEventSchema.index({ chargePointId: 1, timestamp: -1 });

export type SecurityEventAttrs = InferSchemaType<typeof securityEventSchema>;
export type SecurityEventDoc = HydratedDocument<SecurityEventAttrs>;
export const SecurityEvent = model('SecurityEvent', securityEventSchema);

/** Certificates installed on / issued to a charge point. */
const certificateSchema = new Schema(
  {
    chargePointId: { type: Schema.Types.ObjectId, ref: 'ChargePoint', index: true },
    type: { type: String, enum: CERTIFICATE_TYPES, required: true },
    pem: { type: String, required: true },
    serialNumber: { type: String },
    subject: { type: String },
    issuer: { type: String },
    validFrom: { type: Date },
    validTo: { type: Date },
    // CertificateHashDataType — white paper section 6.1
    hashAlgorithm: { type: String, enum: ['SHA256', 'SHA384', 'SHA512', null] },
    issuerNameHash: { type: String },
    issuerKeyHash: { type: String },
    installedAt: { type: Date },
    revokedAt: { type: Date },
    deletedAt: { type: Date },
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

certificateSchema.index({ chargePointId: 1, type: 1 });

export type CertificateAttrs = InferSchemaType<typeof certificateSchema>;
export type CertificateDoc = HydratedDocument<CertificateAttrs>;
export const Certificate = model('Certificate', certificateSchema);

/** SignCertificate.req — white paper use cases A02 / A03. */
const csrRequestSchema = new Schema(
  {
    chargePointId: { type: Schema.Types.ObjectId, ref: 'ChargePoint', required: true, index: true },
    csrPem: { type: String, required: true },
    certificatePem: { type: String },
    status: { type: String, enum: CSR_STATUSES, default: 'Pending', index: true },
    failureReason: { type: String },
    subject: { type: String },
    deliveredAt: { type: Date },
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

export type CsrRequestAttrs = InferSchemaType<typeof csrRequestSchema>;
export type CsrRequestDoc = HydratedDocument<CsrRequestAttrs>;
export const CsrRequest = model('CsrRequest', csrRequestSchema);

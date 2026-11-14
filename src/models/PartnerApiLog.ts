import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const partnerApiLogSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: 'PartnerMerchant', required: true, index: true },
    merchantName: { type: String, required: true },
    merchantUsername: { type: String, required: true, index: true },
    method: { type: String, required: true, index: true },
    endpoint: { type: String, required: true, index: true },
    statusCode: { type: Number, required: true, index: true },
    durationMs: { type: Number, required: true },
    ip: { type: String },
    userAgent: { type: String },
    requestQuery: { type: Schema.Types.Mixed },
    requestBody: { type: Schema.Types.Mixed },
    errorMessage: { type: String },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

partnerApiLogSchema.index({ createdAt: -1 });
partnerApiLogSchema.index({ merchantId: 1, createdAt: -1 });

export type PartnerApiLogAttrs = InferSchemaType<typeof partnerApiLogSchema>;
export type PartnerApiLogDoc = HydratedDocument<PartnerApiLogAttrs>;

export const PartnerApiLog = model('PartnerApiLog', partnerApiLogSchema);

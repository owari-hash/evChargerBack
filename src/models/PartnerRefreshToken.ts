import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const partnerRefreshTokenSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: 'PartnerMerchant', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    family: { type: String, required: true, index: true }, // Rotation family
    expiresAt: { type: Date, required: true },
    isRevoked: { type: Boolean, default: false, index: true },
    createdByIp: { type: String },
    userAgent: { type: String },
  },
  {
    timestamps: true,
  },
);

// Automatic TTL cleanup when token expires
partnerRefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type PartnerRefreshTokenAttrs = InferSchemaType<typeof partnerRefreshTokenSchema>;
export type PartnerRefreshTokenDoc = HydratedDocument<PartnerRefreshTokenAttrs>;

export const PartnerRefreshToken = model('PartnerRefreshToken', partnerRefreshTokenSchema);

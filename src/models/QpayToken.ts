import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * One document per QPay API scope holding the OAuth material returned by
 * `/v2/auth/token`. Tokens are stored encrypted (see services/qpay/crypto.ts),
 * excluded from queries unless explicitly selected, and never serialised to JSON
 * — nothing in the REST API may leak them.
 */
export const QPAY_TOKEN_SCOPES = ['merchant', 'quickqr'] as const;
export type QpayTokenScope = (typeof QPAY_TOKEN_SCOPES)[number];

const qpayTokenSchema = new Schema(
  {
    _id: { type: String, required: true, enum: QPAY_TOKEN_SCOPES }, // scope
    /** AES-256-GCM ciphertext, never the raw token. */
    accessToken: { type: String, required: true, select: false },
    refreshToken: { type: String, select: false },
    tokenType: { type: String, default: 'Bearer' },
    accessExpiresAt: { type: Date, required: true },
    refreshExpiresAt: { type: Date },
    /** Which credential produced this token, so a credential swap invalidates it. */
    credentialFingerprint: { type: String, required: true },
    baseUrl: { type: String, required: true },
    obtainedAt: { type: Date, required: true },
    refreshCount: { type: Number, default: 0 },
  },
  {
    _id: false,
    timestamps: true,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        delete ret.accessToken;
        delete ret.refreshToken;
        delete ret.__v;
        return ret;
      },
    },
  },
);

export type QpayTokenAttrs = InferSchemaType<typeof qpayTokenSchema>;
export type QpayTokenDoc = HydratedDocument<QpayTokenAttrs>;

export const QpayToken = model('QpayToken', qpayTokenSchema);

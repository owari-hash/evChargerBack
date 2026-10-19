import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const itcTokenSchema = new Schema(
  {
    scope: { type: String, default: 'default', unique: true },
    accessToken: { type: String, required: true },
    refreshToken: { type: String },
    expiresAt: { type: Date, required: true },
    refreshCount: { type: Number, default: 0 },
  },
  {
    timestamps: true,
  },
);

export type ItcTokenAttrs = InferSchemaType<typeof itcTokenSchema>;
export type ItcTokenDoc = HydratedDocument<ItcTokenAttrs>;

export const ItcToken = model('ItcToken', itcTokenSchema);

import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const ebarimtMerchantSchema = new Schema(
  {
    name: { type: String, required: true },
    merchantTin: { type: String, required: true, index: true }, // ААН-ийн Регистрийн дугаар
    districtCode: { type: String, default: '23' }, // Дүүргийн код
    branchNo: { type: String, default: '001' },
    posNo: { type: String, default: '0001' },
    
    // Server Environment Options
    envMode: { type: String, enum: ['PRODUCTION', 'TEST'], default: 'PRODUCTION' },
    prodApiUrl: { type: String, default: 'http://103.143.40.43:7080/' },
    testApiUrl: { type: String, default: 'http://103.236.194.50:7080/' },
    legacyApiUrl: { type: String, default: 'http://103.143.40.43:5000/' },
    
    // Legacy fallback field
    ebarimtApiUrl: { type: String, default: 'http://103.143.40.43:7080/' },

    isDefault: { type: Boolean, default: true, index: true },
    enabled: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = String(ret._id);
        delete ret.__v;
        return ret;
      },
    },
  },
);

export type EbarimtMerchantAttrs = InferSchemaType<typeof ebarimtMerchantSchema>;
export type EbarimtMerchantDoc = HydratedDocument<EbarimtMerchantAttrs>;

export const EbarimtMerchant = model('EbarimtMerchant', ebarimtMerchantSchema);

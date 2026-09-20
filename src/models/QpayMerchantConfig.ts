import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { logger } from '../lib/logger';

const qpayMerchantConfigSchema = new Schema(
  {
    merchantId: { type: String, required: true, index: true },
    merchantName: { type: String, default: 'ЗЭВ ТАБС ХХК' },
    mccCode: { type: String, default: '5311' },
    bankCode: { type: String, default: '050000' }, // 050000 = Хаан банк
    accountNumber: { type: String, default: '5475332224' },
    accountName: { type: String, default: 'ЗЭВ ТАБС ХХК' },
    isActive: { type: Boolean, default: true, index: true },
    updatedBy: { type: String },
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

export type QpayMerchantConfigAttrs = InferSchemaType<typeof qpayMerchantConfigSchema>;
export type QpayMerchantConfigDoc = HydratedDocument<QpayMerchantConfigAttrs>;

export const QpayMerchantConfig = model('QpayMerchantConfig', qpayMerchantConfigSchema);

export async function ensureDefaultQpayMerchantConfig(): Promise<void> {
  try {
    const count = await QpayMerchantConfig.countDocuments();
    if (count === 0) {
      await QpayMerchantConfig.create({
        merchantId: process.env.QPAY_QUICKQR_MERCHANT_ID || 'cc1a2b2f-aa84-474a-953c-c55b575a9883',
        merchantName: process.env.QPAY_QUICKQR_ACCOUNT_NAME || 'ЗЭВ ТАБС ХХК',
        mccCode: process.env.QPAY_QUICKQR_MCC_CODE || '5311',
        bankCode: process.env.QPAY_QUICKQR_BANK_CODE || '050000',
        accountNumber: process.env.QPAY_QUICKQR_ACCOUNT_NUMBER || '5475332224',
        accountName: process.env.QPAY_QUICKQR_ACCOUNT_NAME || 'ЗЭВ ТАБС ХХК',
        isActive: true,
      });
      logger.info('[qpay] Seeded default QpayMerchantConfig record in MongoDB');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, '[qpay] Error seeding default QpayMerchantConfig');
  }
}

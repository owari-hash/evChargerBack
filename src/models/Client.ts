import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const clientSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, index: true },
    businessRegister: { type: String, trim: true, index: true }, // Регистрийн дугаар / ААН-ийн дугаар
    contactPerson: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    address: { type: String, trim: true },
    description: { type: String, trim: true },
    isActive: { type: Boolean, default: true, index: true },

    /** Eplug's service fee on this client's stations. Unset = network default. */
    feePercent: { type: Number, min: 0, max: 100 },
    /** Receipts for sessions at this client's stations are issued under this merchant's TIN. */
    ebarimtMerchantId: { type: Schema.Types.ObjectId, ref: 'EbarimtMerchant' },
    /** Where Eplug pays the client's earnings out to. */
    payoutAccount: {
      bankCode: { type: String, trim: true },
      bankName: { type: String, trim: true },
      accountNumber: { type: String, trim: true },
      accountName: { type: String, trim: true },
    },
    allowedMenus: { type: [String], default: undefined },
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

export type ClientAttrs = InferSchemaType<typeof clientSchema>;
export type ClientDoc = HydratedDocument<ClientAttrs>;

export const Client = model('Client', clientSchema);

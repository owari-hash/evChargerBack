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

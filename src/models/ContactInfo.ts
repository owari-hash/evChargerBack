import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * Холбоо барих мэдээлэл — Contact & social links shown in the website/kiosk footer.
 * Configurable via the admin console so operators can update phone numbers,
 * email and social links without code changes.
 */
const contactInfoSchema = new Schema(
  {
    phone: { type: String, default: '+976 7777 4242, 8888 5516', trim: true },
    email: { type: String, default: 'contact@eplug.mn', trim: true },
    address: { type: String, default: 'Улаанбаатар хот', trim: true },
    facebookUrl: { type: String, default: 'https://facebook.com/eplug.mn', trim: true },
    facebookName: { type: String, default: 'Eplug.mn', trim: true },
    instagramUrl: { type: String, default: 'https://instagram.com/eplug.mn', trim: true },
    instagramName: { type: String, default: 'Eplug.mn', trim: true },
    logoDownloadUrl: { type: String, default: '/eplug-mark.png', trim: true },
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

export type ContactInfoAttrs = InferSchemaType<typeof contactInfoSchema>;
export type ContactInfoDoc = HydratedDocument<ContactInfoAttrs>;

export const ContactInfo = model('ContactInfo', contactInfoSchema);

export const DEFAULT_CONTACT_INFO: Omit<ContactInfoAttrs, 'createdAt' | 'updatedAt'> = {
  phone: '+976 7777 4242, 8888 5516',
  email: 'contact@eplug.mn',
  address: 'Улаанбаатар хот',
  facebookUrl: 'https://facebook.com/eplug.mn',
  facebookName: 'Eplug.mn',
  instagramUrl: 'https://instagram.com/eplug.mn',
  instagramName: 'Eplug.mn',
  logoDownloadUrl: '/eplug-mark.png',
  updatedBy: undefined,
};

export async function getOrCreateContactInfo(): Promise<ContactInfoDoc> {
  let doc = await ContactInfo.findOne();
  if (!doc) {
    doc = await ContactInfo.create(DEFAULT_CONTACT_INFO);
  }
  return doc;
}

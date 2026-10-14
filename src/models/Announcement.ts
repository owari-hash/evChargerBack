import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * Мэдээ — an announcement an operator writes in the console that every
 * signed-in driver sees once, as a modal, the next time they open the kiosk
 * or the app. Title, body and an optional image; nothing fancier, since this
 * is a bulletin board, not a CMS.
 */
const announcementSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, trim: true, maxlength: 4000 },
    /** Served from this API's own /uploads mount; null means text-only. */
    imageUrl: { type: String },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: String },
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

announcementSchema.index({ isActive: 1, createdAt: -1 });

export type AnnouncementAttrs = InferSchemaType<typeof announcementSchema>;
export type AnnouncementDoc = HydratedDocument<AnnouncementAttrs>;

export const Announcement = model('Announcement', announcementSchema);

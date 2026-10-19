import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const adminNotificationSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    key: { type: String, required: true },
    kind: { type: String, required: true },
    title: { type: String, required: true },
    detail: { type: String, required: true },
    tone: { type: String, default: 'info' },
    href: { type: String },
    at: { type: Date, default: Date.now },
    isRead: { type: Boolean, default: false, index: true },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = String(ret._id);
        delete ret.__v;
        return ret;
      },
    },
  },
);

adminNotificationSchema.index({ userId: 1, key: 1 }, { unique: true });
adminNotificationSchema.index({ userId: 1, at: -1 });

export type AdminNotificationAttrs = InferSchemaType<typeof adminNotificationSchema>;
export type AdminNotificationDoc = HydratedDocument<AdminNotificationAttrs>;

export const AdminNotification = model('AdminNotification', adminNotificationSchema);

import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const driverNotificationSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    kind: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    imageUrl: { type: String },
    href: { type: String },
    dedupeKey: { type: String },
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

driverNotificationSchema.index({ userId: 1, dedupeKey: 1 }, { sparse: true });
driverNotificationSchema.index({ userId: 1, at: -1 });

export type DriverNotificationAttrs = InferSchemaType<typeof driverNotificationSchema>;
export type DriverNotificationDoc = HydratedDocument<DriverNotificationAttrs>;

export const DriverNotification = model('DriverNotification', driverNotificationSchema);

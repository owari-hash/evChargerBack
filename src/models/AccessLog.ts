import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const accessLogSchema = new Schema(
  {
    timestamp: { type: Date, default: Date.now, index: true },
    date: { type: String, required: true, index: true },
    hour: { type: Number, required: true, min: 0, max: 23 },
    platform: { type: String, enum: ['web', 'ios', 'android'], required: true, index: true },
    clientType: { type: String, enum: ['web', 'app'], required: true },
    path: { type: String, required: true, trim: true },
    visitorId: { type: String, required: true, index: true },
    referrer: { type: String, trim: true, default: '' },
    device: { type: String, enum: ['mobile', 'desktop', 'tablet'], default: 'mobile' },
    os: { type: String, default: 'Other' },
    browser: { type: String, default: 'Other' },
  },
  {
    timestamps: false,
    versionKey: false,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = String(ret._id);
        delete ret.__v;
        return ret;
      },
    },
  },
);

// Auto-purge records older than 90 days to conserve storage
accessLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
accessLogSchema.index({ date: 1, platform: 1 });
accessLogSchema.index({ date: 1, visitorId: 1 });
accessLogSchema.index({ date: 1, path: 1 });

export type AccessLogAttrs = InferSchemaType<typeof accessLogSchema>;
export type AccessLogDoc = HydratedDocument<AccessLogAttrs>;

export const AccessLog = model('AccessLog', accessLogSchema);

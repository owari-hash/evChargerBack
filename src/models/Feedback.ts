import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * Санал хүсэлт — a note a driver sends from the kiosk footer (or the app).
 * A signed-in driver's account and phone are attached by the server; a guest
 * types a phone number so the operator can call back. Operators read and
 * close them in the console's «Санал хүсэлт» page.
 */
const feedbackSchema = new Schema(
  {
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    phone: { type: String, trim: true, maxlength: 32 },
    /** Driver account id when the sender was signed in. */
    userId: { type: String, index: true },
    userName: { type: String, trim: true },
    source: { type: String, enum: ['web', 'app'], default: 'web' },
    status: { type: String, enum: ['new', 'done'], default: 'new', index: true },
    handledBy: { type: String },
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

feedbackSchema.index({ status: 1, createdAt: -1 });

export type FeedbackAttrs = InferSchemaType<typeof feedbackSchema>;
export type FeedbackDoc = HydratedDocument<FeedbackAttrs>;

export const Feedback = model('Feedback', feedbackSchema);

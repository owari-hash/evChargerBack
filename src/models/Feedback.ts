<<<<<<< HEAD
import { Schema, model, type Document } from 'mongoose';

export interface FeedbackDoc extends Document {
  phone?: string;
  message: string;
  source?: string;
  userId?: string;
  status: 'NEW' | 'READ' | 'RESOLVED';
  smsDeliveredTo: string[];
  createdAt: Date;
  updatedAt: Date;
}

const feedbackSchema = new Schema<FeedbackDoc>(
  {
    phone: { type: String, trim: true },
    message: { type: String, required: true, trim: true },
    source: { type: String, default: 'web', trim: true },
    userId: { type: String, trim: true },
    status: { type: String, enum: ['NEW', 'READ', 'RESOLVED'], default: 'NEW' },
    smsDeliveredTo: { type: [String], default: [] },
  },
  { timestamps: true },
);

feedbackSchema.index({ createdAt: -1 });
feedbackSchema.index({ status: 1 });

export const Feedback = model<FeedbackDoc>('Feedback', feedbackSchema);
=======
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
>>>>>>> 930a66477af5d205b73aa492f2dda061218dc4c3

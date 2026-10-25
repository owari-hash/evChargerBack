import { Schema, model, type Document } from 'mongoose';

export interface FeedbackDoc extends Document {
  message: string;
  phone?: string;
  userId?: string;
  userName?: string;
  source: 'web' | 'app';
  status: 'new' | 'done' | 'NEW' | 'READ' | 'RESOLVED';
  handledBy?: string;
  smsDeliveredTo: string[];
  createdAt: Date;
  updatedAt: Date;
}

const feedbackSchema = new Schema<FeedbackDoc>(
  {
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    phone: { type: String, trim: true, maxlength: 32 },
    userId: { type: String, index: true },
    userName: { type: String, trim: true },
    source: { type: String, enum: ['web', 'app'], default: 'web' },
    status: { type: String, enum: ['new', 'done', 'NEW', 'READ', 'RESOLVED'], default: 'new', index: true },
    handledBy: { type: String },
    smsDeliveredTo: { type: [String], default: [] },
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

export const Feedback = model<FeedbackDoc>('Feedback', feedbackSchema);

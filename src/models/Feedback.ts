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

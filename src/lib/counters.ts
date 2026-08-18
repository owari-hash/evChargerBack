import { Schema, model } from 'mongoose';

/**
 * OCPP 1.6 requires integer identifiers for transactionId, reservationId and
 * requestId. MongoDB has no auto-increment, so we keep an atomic counter
 * collection and use findOneAndUpdate($inc) which is atomic on a single document.
 */
interface CounterDoc {
  _id: string;
  seq: number;
}

const counterSchema = new Schema<CounterDoc>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false },
);

export const Counter = model<CounterDoc>('Counter', counterSchema);

export type CounterName =
  | 'transactionId'
  | 'reservationId'
  | 'requestId'
  | 'chargingProfileId'
  | 'localListVersion';

export async function nextSequence(name: CounterName): Promise<number> {
  const doc = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  ).lean();
  return doc!.seq;
}

/** Bump a counter so it is at least `value` (used when a charge point reports a higher id). */
export async function ensureSequenceAtLeast(name: CounterName, value: number): Promise<void> {
  await Counter.updateOne(
    { _id: name, seq: { $lt: value } },
    { $set: { seq: value } },
    { upsert: true },
  ).catch(() => undefined);
}

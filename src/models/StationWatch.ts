import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * "Tell me when a plug is free here." One per driver per station; removed when
 * it fires, and by Mongo's TTL sweep once `expiresAt` passes.
 */
const stationWatchSchema = new Schema(
  {
    userId: { type: String, required: true },
    /** Station `_id` as a string — what the driver URLs use. */
    stationId: { type: String, required: true },
    /** OCPP identity — what `connector.status` events carry. */
    cpId: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

stationWatchSchema.index({ userId: 1, stationId: 1 }, { unique: true });
stationWatchSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type StationWatchAttrs = InferSchemaType<typeof stationWatchSchema>;

export const StationWatch = model('StationWatch', stationWatchSchema);

import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { MESSAGE_DIRECTIONS, COMMAND_STATUSES } from './enums';
import { env } from '../config/env';

/** Raw OCPP-J frame audit trail. */
const ocppMessageLogSchema = new Schema(
  {
    chargePointId: { type: String, required: true, index: true },
    direction: { type: String, enum: MESSAGE_DIRECTIONS, required: true },
    messageTypeId: { type: Number, required: true }, // 2 CALL, 3 CALLRESULT, 4 CALLERROR
    uniqueId: { type: String, required: true, index: true },
    action: { type: String, index: true },
    payload: { type: Schema.Types.Mixed },
    errorCode: { type: String },
    errorDescription: { type: String },
    timestamp: { type: Date, default: Date.now },
  },
  {
    versionKey: false,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = ret._id;
        return ret;
      },
    },
  },
);

ocppMessageLogSchema.index({ chargePointId: 1, timestamp: -1 });

if (env.OCPP_LOG_RETENTION_DAYS > 0) {
  ocppMessageLogSchema.index(
    { timestamp: 1 },
    { expireAfterSeconds: env.OCPP_LOG_RETENTION_DAYS * 86_400 },
  );
}

export type OcppMessageLogAttrs = InferSchemaType<typeof ocppMessageLogSchema>;
export type OcppMessageLogDoc = HydratedDocument<OcppMessageLogAttrs>;
export const OcppMessageLog = model('OcppMessageLog', ocppMessageLogSchema);

/** One row per Central System -> Charge Point command, with its result. */
const commandLogSchema = new Schema(
  {
    chargePointId: { type: String, required: true, index: true },
    action: { type: String, required: true, index: true },
    uniqueId: { type: String, required: true },
    request: { type: Schema.Types.Mixed },
    response: { type: Schema.Types.Mixed },
    status: { type: String, enum: COMMAND_STATUSES, default: 'Pending', index: true },
    error: { type: String },
    issuedBy: { type: String },
    durationMs: { type: Number },
    completedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

commandLogSchema.index({ chargePointId: 1, createdAt: -1 });

export type CommandLogAttrs = InferSchemaType<typeof commandLogSchema>;
export type CommandLogDoc = HydratedDocument<CommandLogAttrs>;
export const CommandLog = model('CommandLog', commandLogSchema);

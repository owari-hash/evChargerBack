import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

export const POWER_ALERT_TYPES = [
  'STATION_OFFLINE',
  'PILE_OFFLINE',
  'CAPACITY_EXCEEDED',
  'POSSIBLE_UNDERPERFORMANCE',
  'POSSIBLE_POWER_LOSS',
  'VOLTAGE_OUT_OF_RANGE',
  'CURRENT_OUT_OF_RANGE',
  'TELEMETRY_MISSING',
  'UNEXPECTED_TERMINATION',
  'POWER_FLUCTUATION',
  'REPEATED_STATION_FAULT',
] as const;
export type PowerAlertType = (typeof POWER_ALERT_TYPES)[number];

export const POWER_ALERT_SEVERITIES = ['CRITICAL', 'WARNING', 'INFO'] as const;
export type PowerAlertSeverity = (typeof POWER_ALERT_SEVERITIES)[number];

export const POWER_ALERT_STATUSES = ['ACTIVE', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export type PowerAlertStatus = (typeof POWER_ALERT_STATUSES)[number];

const powerAlertSchema = new Schema(
  {
    chargePointId: { type: Schema.Types.ObjectId, ref: 'ChargePoint', required: true, index: true },
    cpId: { type: String, required: true, index: true },
    connectorId: { type: Number, index: true },
    alertType: { type: String, enum: POWER_ALERT_TYPES, required: true, index: true },
    severity: { type: String, enum: POWER_ALERT_SEVERITIES, default: 'WARNING', index: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    status: { type: String, enum: POWER_ALERT_STATUSES, default: 'ACTIVE', index: true },
    firstSeenAt: { type: Date, default: () => new Date(), index: true },
    lastSeenAt: { type: Date, default: () => new Date(), index: true },
    resolvedAt: { type: Date },
    resolvedBy: { type: String },
    measuredValues: { type: Schema.Types.Mixed },
    threshold: { type: Schema.Types.Mixed },
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

powerAlertSchema.index({ cpId: 1, alertType: 1, status: 1 });
powerAlertSchema.index({ status: 1, lastSeenAt: -1 });

export type PowerAlertAttrs = InferSchemaType<typeof powerAlertSchema>;
export type PowerAlertDoc = HydratedDocument<PowerAlertAttrs>;

export const PowerAlert = model('PowerAlert', powerAlertSchema);

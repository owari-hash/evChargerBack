import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { TRANSACTION_STATUSES, STOP_REASONS } from './enums';

const transactionSchema = new Schema(
  {
    // OCPP transactionId — an integer allocated by us via the Counter collection
    _id: { type: Number, required: true },

    chargePointId: { type: Schema.Types.ObjectId, ref: 'ChargePoint', required: true, index: true },
    connectorId: { type: Number, required: true },
    idTag: { type: String, required: true, index: true },
    status: { type: String, enum: TRANSACTION_STATUSES, default: 'Active', index: true },

    meterStart: { type: Number, required: true }, // Wh
    meterStop: { type: Number }, // Wh
    energyWh: { type: Number, default: 0 },

    startTimestamp: { type: Date, required: true, index: true },
    stopTimestamp: { type: Date },
    stopReason: { type: String, enum: [...STOP_REASONS, null] },
    stopIdTag: { type: String },

    reservationId: { type: Number },
    startedRemotely: { type: Boolean, default: false },
    stoppedRemotely: { type: Boolean, default: false },

    // Latest telemetry, denormalised for cheap dashboard reads
    lastMeterWh: { type: Number },
    lastPowerW: { type: Number },
    lastSocPercent: { type: Number },
    lastMeterValueAt: { type: Date },

    tariffPerKwh: { type: Number },
    cost: { type: Number },

    ebarimt: {
      receiptId: { type: String },
      type: { type: String, enum: ['B2C_RECEIPT', 'B2B_RECEIPT'] },
      qrData: { type: String },
      lottery: { type: String },
      merchantTin: { type: String },
      customerNo: { type: String },
      customerTin: { type: String },
      totalAmount: { type: Number },
      totalVAT: { type: Number },
      status: { type: String, enum: ['SUCCESS', 'FAILED', 'PENDING'] },
      issuedAt: { type: Date },
      error: { type: String },
    },
  },
  {
    timestamps: true,
    _id: false,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        ret.transactionId = ret._id;
        ret.id = ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

transactionSchema.index({ chargePointId: 1, connectorId: 1, status: 1 });
transactionSchema.index({ startTimestamp: -1 });

export type TransactionAttrs = InferSchemaType<typeof transactionSchema>;
export type TransactionDoc = HydratedDocument<TransactionAttrs>;

export const Transaction = model('Transaction', transactionSchema);

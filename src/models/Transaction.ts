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
    /** Total the driver pays: energyCost + feeAmount. */
    cost: { type: Number },
    /** kWh × tariffPerKwh. */
    energyCost: { type: Number },
    /** Eplug's service fee, energyCost × feePercent / 100. */
    feeAmount: { type: Number },
    /** Fee and owning client as they were when the session started. */
    feePercent: { type: Number },
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', index: true },

    /**
     * True when the CSMS closed the session itself (reboot orphan, operator
     * force-close) from the last known meter. The station's own StopTransaction
     * may still arrive with the real meterStop; it then re-settles the bill once.
     */
    closedByCsms: { type: Boolean, default: false },

    /** Буцаалт — the session's charge returned to the wallet. */
    refund: {
      state: { type: String, enum: ['PENDING', 'DONE'] },
      amount: { type: Number },
      reason: { type: String },
      refundedBy: { type: String },
      refundedAt: { type: Date },
      walletEntryId: { type: String },
      /** Whether a real e-barimt receipt was returned at the PosAPI. */
      ebarimtReturned: { type: Boolean },
    },

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
      status: { type: String, enum: ['SUCCESS', 'FAILED', 'PENDING', 'REFUNDED'] },
      issuedAt: { type: Date },
      /** Set when the receipt was returned (cancelled) at the PosAPI. */
      returnedAt: { type: Date },
      returnResponse: { type: Schema.Types.Mixed },
      error: { type: String },
      rawResponse: { type: Schema.Types.Mixed },
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

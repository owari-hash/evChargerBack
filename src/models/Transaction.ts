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

    // Vehicle identification & telemetry (from GB/T BRM, ISO 15118, or DataTransfer)
    vehicleVin: { type: String, index: true, sparse: true },
    vehicleModel: { type: String },
    vehicleSoc: { type: Number },
    vehicleBatteryKwh: { type: Number },
    vehicleData: { type: Schema.Types.Mixed },

    /** The session's blended rate once billed — see `tariffZones` below. */
    tariffPerKwh: { type: Number },
    /**
     * The station's time-of-day zones as they stood when this session
     * started — snapshotted so a schedule change never reprices a session
     * already running. Absent/empty means the flat `tariffPerKwh` applied for
     * the whole session, same as before this field existed.
     */
    tariffZones: {
      type: [
        {
          _id: false,
          name: { type: String, trim: true },
          startMinute: { type: Number },
          endMinute: { type: Number },
          tariffPerKwh: { type: Number },
        },
      ],
    },
    /** Total the driver pays: kWh × tariffPerKwh (cost = energyCost + feeAmount). */
    cost: { type: Number },
    /** Merchant / Client share: cost - feeAmount. */
    energyCost: { type: Number },
    /** Eplug's service fee: cost × feePercent / 100. */
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
      accountNumber: { type: String },
      refundedBy: { type: String },
      refundedAt: { type: Date },
      walletEntryId: { type: String },
      /** Whether a real e-barimt receipt was returned at the PosAPI. */
      ebarimtReturned: { type: Boolean },
    },

    /**
     * The e-barimt the driver chose when they pressed Charge: personal (B2C)
     * or a company TIN (B2B). Issued automatically once the session is billed;
     * `ebarimt` below holds the receipt itself.
     */
    ebarimtRequest: {
      type: { type: String, enum: ['B2C_RECEIPT', 'B2B_RECEIPT'] },
      customerTin: { type: String },
      customerName: { type: String },
      requestedAt: { type: Date },
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
      returnedBy: { type: String },
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

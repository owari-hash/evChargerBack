import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { RESERVATION_STATES } from './enums';

const reservationSchema = new Schema(
  {
    _id: { type: Number, required: true }, // OCPP reservationId
    chargePointId: { type: Schema.Types.ObjectId, ref: 'ChargePoint', required: true, index: true },
    connectorId: { type: Number, required: true },
    idTag: { type: String, required: true },
    parentIdTag: { type: String },
    expiryDate: { type: Date, required: true },
    state: { type: String, enum: RESERVATION_STATES, default: 'Active', index: true },
    transactionId: { type: Number },
  },
  {
    timestamps: true,
    _id: false,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        ret.reservationId = ret._id;
        ret.id = ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

reservationSchema.index({ chargePointId: 1, connectorId: 1, state: 1 });

export type ReservationAttrs = InferSchemaType<typeof reservationSchema>;
export type ReservationDoc = HydratedDocument<ReservationAttrs>;

export const Reservation = model('Reservation', reservationSchema);

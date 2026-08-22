import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const configurationKeySchema = new Schema(
  {
    chargePointId: { type: Schema.Types.ObjectId, ref: 'ChargePoint', required: true, index: true },
    key: { type: String, required: true },
    value: { type: String },
    readonly: { type: Boolean, default: false },
    // Set when the charge point answered GetConfiguration with unknownKey
    known: { type: Boolean, default: true },
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

configurationKeySchema.index({ chargePointId: 1, key: 1 }, { unique: true });

export type ConfigurationKeyAttrs = InferSchemaType<typeof configurationKeySchema>;
export type ConfigurationKeyDoc = HydratedDocument<ConfigurationKeyAttrs>;

export const ConfigurationKey = model('ConfigurationKey', configurationKeySchema);

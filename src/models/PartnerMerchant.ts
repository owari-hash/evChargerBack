import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import bcrypt from 'bcryptjs';

export const PARTNER_SCOPES = [
  'stations:read',
  'stations:write',
  'connectors:read',
  'sessions:read',
  'sessions:control',
  'tariffs:read',
] as const;

export type PartnerScope = (typeof PARTNER_SCOPES)[number];

const partnerMerchantSchema = new Schema(
  {
    /** Display name of the partner, e.g. "Токи ХХК", "Таван Богд", "Монпэй" */
    name: { type: String, required: true, trim: true, index: true },

    /** Unique code identifier, e.g. "toki", "tavan-bogd" */
    code: { type: String, required: true, unique: true, trim: true, lowercase: true },

    /** Username used by the partner for API authentication */
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },

    /** Bcrypt hashed password */
    passwordHash: { type: String, required: true, select: false },

    /** Optional reference to a registered Client/Owner */
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', index: true },

    /** Allowed station cpIds (empty or undefined means access to all stations) */
    allowedStations: { type: [String], default: [] },

    /** Allowed API scopes */
    allowedScopes: {
      type: [String],
      default: ['stations:read', 'connectors:read', 'sessions:read', 'sessions:control', 'tariffs:read'],
    },

    /** Active status: if false, API calls and logins are instantly blocked */
    isActive: { type: Boolean, default: true, index: true },

    /** Optional IP addresses / CIDR allowed to call APIs */
    ipWhitelist: { type: [String], default: [] },

    /** Rate limit per minute (0 = default 120/min) */
    rateLimitPerMin: { type: Number, default: 120 },

    /** Contact person details */
    contactName: { type: String, trim: true },
    contactPhone: { type: String, trim: true },
    contactEmail: { type: String, trim: true, lowercase: true },
    description: { type: String, trim: true },

    /** Incremented when tokens are revoked so old access/refresh tokens are invalidated */
    tokenVersion: { type: Number, default: 0 },

    /** Telemetry */
    lastLoginAt: { type: Date },
    lastActiveAt: { type: Date },
    totalApiCalls: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = String(ret._id);
        if (ret.clientId) ret.clientId = String(ret.clientId);
        delete ret.passwordHash;
        delete ret.__v;
        return ret;
      },
    },
  },
);

export type PartnerMerchantAttrs = InferSchemaType<typeof partnerMerchantSchema>;
export type PartnerMerchantDoc = HydratedDocument<PartnerMerchantAttrs>;

export const PartnerMerchant = model('PartnerMerchant', partnerMerchantSchema);

export async function hashPartnerPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPartnerPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

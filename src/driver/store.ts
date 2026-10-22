import { Schema, model, models, type Model } from 'mongoose';
import { driverLogger } from './http';

/**
 * Driver accounts and their one-time codes.
 *
 * These are the collections the kiosk web app created (`driverusers`,
 * `driververificationtokens`). The API moved here but the documents did not, so
 * every existing account keeps working. Operator logins stay in `users`.
 */

export interface StoredUser {
  id: string;
  /** Optional: accounts are created with a phone number and a PIN alone. */
  email?: string;
  phone?: string;
  name?: string;
  /** Only on accounts created before PIN sign-in; no longer checked anywhere. */
  passwordHash?: string;
  /** bcrypt of the 4-digit sign-in PIN. Absent until the driver sets one. */
  pinHash?: string;
  /** Wrong PINs in a row since the last successful sign-in or reset. */
  failedPinAttempts?: number;
  pinLockedUntil?: string;
  emailVerifiedAt?: string;
  phoneVerifiedAt?: string;
  isActive: boolean;
  /** True if this is an internal driver who charges free. */
  isInternal?: boolean;
  /** The account's charge tag — the identity OCPP authorises against. */
  idTag?: string;
  /** The vehicle this driver charges — shown on an active session, not OCPP data. */
  vehicleBrand?: string;
  vehicleModel?: string;
  /** 8-digit E-Barimt user code or phone number for automatic easy registration. */
  ebarimtCustomerNo?: string;
  /**
   * First-run guides this driver has not finished yet, per surface (see
   * DRIVER_GUIDES). Set on new accounts only — accounts from before the guides
   * existed have none, so existing drivers are never shown one.
   */
  pendingGuides?: string[];
  locale: string;
  /** Bumped on PIN reset or change so existing session cookies stop validating. */
  tokenVersion: number;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

export type TokenKind = 'email_verify' | 'password_reset' | 'phone_verify';
export type TokenChannel = 'email' | 'sms';

export interface StoredToken {
  id: string;
  userId: string;
  kind: TokenKind;
  /** SHA-256 of the emailed link secret or of the SMS one-time code. */
  secretHash: string;
  channel: TokenChannel;
  /** Address the secret was sent to, so we can show "sent to j***@x.mn". */
  destination: string;
  expiresAt: string;
  attempts: number;
  usedAt?: string;
  createdAt: string;
}

/** The surfaces with a first-run guide: the mobile app and the website. */
export const DRIVER_GUIDES = ['app', 'web'] as const;
export type DriverGuide = (typeof DRIVER_GUIDES)[number];

export interface NewUser {
  email?: string;
  phone?: string;
  phoneVerifiedAt?: string;
  name?: string;
  pinHash?: string;
  locale?: string;
}

export interface NewToken {
  userId: string;
  kind: TokenKind;
  secretHash: string;
  channel: TokenChannel;
  destination: string;
  expiresAt: Date;
}

const driverUserSchema = new Schema(
  {
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    name: { type: String, trim: true },
    passwordHash: { type: String },
    pinHash: { type: String },
    failedPinAttempts: { type: Number, default: 0 },
    pinLockedUntil: { type: Date },
    emailVerifiedAt: { type: Date },
    phoneVerifiedAt: { type: Date },
    isActive: { type: Boolean, default: true },
    isInternal: { type: Boolean, default: false },
    idTag: { type: String, index: true, sparse: true },
    vehicleBrand: { type: String, trim: true },
    vehicleModel: { type: String, trim: true },
    ebarimtCustomerNo: { type: String, trim: true },
    // No default: documents written before the guides existed stay without it.
    pendingGuides: { type: [String], default: undefined },
    locale: { type: String, default: 'en' },
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date },
  },
  { timestamps: true, collection: 'driverusers' },
);

// Unique only where present: an account may have no email. The phone number is
// the sign-in identity, so two accounts must never share one.
driverUserSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
);
driverUserSchema.index(
  { phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: 'string' } } },
);

const verificationTokenSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    kind: {
      type: String,
      required: true,
      enum: ['email_verify', 'password_reset', 'phone_verify'],
    },
    secretHash: { type: String, required: true },
    channel: { type: String, required: true, enum: ['email', 'sms'] },
    destination: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    usedAt: { type: Date },
  },
  { timestamps: true, collection: 'driververificationtokens' },
);

// Expired tokens are swept by Mongo itself.
verificationTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 });
verificationTokenSchema.index({ userId: 1, kind: 1, usedAt: 1 });

interface DriverUserDoc {
  _id: unknown;
  pendingGuides?: string[];
  email?: string;
  phone?: string;
  name?: string;
  passwordHash?: string;
  pinHash?: string;
  failedPinAttempts?: number;
  pinLockedUntil?: Date;
  emailVerifiedAt?: Date;
  phoneVerifiedAt?: Date;
  isActive: boolean;
  isInternal?: boolean;
  idTag?: string;
  vehicleBrand?: string;
  vehicleModel?: string;
  ebarimtCustomerNo?: string;
  locale: string;
  tokenVersion: number;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface VerificationTokenDoc {
  _id: unknown;
  userId: string;
  kind: TokenKind;
  secretHash: string;
  channel: TokenChannel;
  destination: string;
  expiresAt: Date;
  attempts: number;
  usedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const DriverUser: Model<DriverUserDoc> =
  (models.DriverUser as Model<DriverUserDoc>) ??
  model<DriverUserDoc>('DriverUser', driverUserSchema);

const VerificationToken: Model<VerificationTokenDoc> =
  (models.DriverVerificationToken as Model<VerificationTokenDoc>) ??
  model<VerificationTokenDoc>('DriverVerificationToken', verificationTokenSchema);

function toUser(doc: DriverUserDoc): StoredUser {
  return {
    id: String(doc._id),
    email: doc.email || undefined,
    phone: doc.phone || undefined,
    name: doc.name || undefined,
    passwordHash: doc.passwordHash || undefined,
    pinHash: doc.pinHash || undefined,
    failedPinAttempts: doc.failedPinAttempts ?? 0,
    pinLockedUntil: doc.pinLockedUntil?.toISOString(),
    emailVerifiedAt: doc.emailVerifiedAt?.toISOString(),
    phoneVerifiedAt: doc.phoneVerifiedAt?.toISOString(),
    isActive: doc.isActive !== false,
    isInternal: doc.isInternal === true,
    idTag: doc.idTag ?? undefined,
    vehicleBrand: doc.vehicleBrand || undefined,
    vehicleModel: doc.vehicleModel || undefined,
    ebarimtCustomerNo: doc.ebarimtCustomerNo || undefined,
    pendingGuides: doc.pendingGuides?.length ? [...doc.pendingGuides] : undefined,
    locale: doc.locale ?? 'en',
    tokenVersion: doc.tokenVersion ?? 0,
    createdAt: doc.createdAt?.toISOString() ?? new Date().toISOString(),
    updatedAt: doc.updatedAt?.toISOString() ?? new Date().toISOString(),
    lastLoginAt: doc.lastLoginAt?.toISOString(),
  };
}

function toToken(doc: VerificationTokenDoc): StoredToken {
  return {
    id: String(doc._id),
    userId: doc.userId,
    kind: doc.kind,
    secretHash: doc.secretHash,
    channel: doc.channel,
    destination: doc.destination,
    expiresAt: doc.expiresAt.toISOString(),
    attempts: doc.attempts ?? 0,
    usedAt: doc.usedAt?.toISOString(),
    createdAt: doc.createdAt?.toISOString() ?? new Date().toISOString(),
  };
}

/** Maps a `StoredUser` patch onto the document; `undefined` removes the field. */
function toUpdate(patch: Partial<StoredUser>): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};
  const dates = ['emailVerifiedAt', 'phoneVerifiedAt', 'lastLoginAt', 'pinLockedUntil'];

  for (const [key, value] of Object.entries(patch)) {
    if (key === 'id' || key === 'createdAt' || key === 'updatedAt') continue;
    if (value === undefined || value === null) {
      unset[key] = 1;
      continue;
    }
    update[key] = dates.includes(key) ? new Date(value as string) : value;
  }

  return Object.keys(unset).length > 0 ? { $set: update, $unset: unset } : update;
}

const isObjectId = (id: string) => /^[a-f\d]{24}$/i.test(id);

let indexesReady: Promise<void> | null = null;

/**
 * Deployments from before PIN sign-in built `email_1` unique across every
 * document and `phone_1` as a plain sparse index. Mongo will not build an index
 * whose name is taken by one with different options, so those are dropped first.
 */
async function ensureIndexes(): Promise<void> {
  const collection = DriverUser.collection;
  let existing: Array<{ name?: string; partialFilterExpression?: unknown }> = [];
  try {
    existing = await collection.indexes();
  } catch {
    /* A missing collection has no indexes to fix. */
  }
  for (const name of ['email_1', 'phone_1']) {
    const index = existing.find((candidate) => candidate.name === name);
    if (index && !index.partialFilterExpression) {
      await collection.dropIndex(name).catch(() => undefined);
    }
  }
  try {
    await DriverUser.createIndexes();
  } catch (err) {
    // Most likely two accounts share a phone number. Sign-in still works; the
    // duplicates need resolving by hand before the index can be built.
    driverLogger.error({ err }, 'could not build driver user indexes');
  }
}

async function ready(): Promise<void> {
  indexesReady ??= ensureIndexes().catch((err: unknown) => {
    indexesReady = null;
    throw err;
  });
  await indexesReady;
}

export const store = {
  async findUserById(id: string): Promise<StoredUser | null> {
    await ready();
    if (!isObjectId(id)) return null;
    const doc = await DriverUser.findById(id).lean<DriverUserDoc>();
    return doc ? toUser(doc) : null;
  },

  async findUserByEmail(email: string): Promise<StoredUser | null> {
    await ready();
    const doc = await DriverUser.findOne({ email: email.toLowerCase() }).lean<DriverUserDoc>();
    return doc ? toUser(doc) : null;
  },

  async findUserByPhone(phone: string): Promise<StoredUser | null> {
    await ready();
    const doc = await DriverUser.findOne({ phone }).lean<DriverUserDoc>();
    return doc ? toUser(doc) : null;
  },

  /**
   * The account a charge tag belongs to — how the CSMS console shows which
   * driver and vehicle a transaction's bare `idTag` actually was.
   */
  async findUserByIdTag(idTag: string): Promise<StoredUser | null> {
    await ready();
    const doc = await DriverUser.findOne({ idTag }).lean<DriverUserDoc>();
    return doc ? toUser(doc) : null;
  },

  /** Accounts by id, batched for a list — one query, not one per row. */
  async findUsersByIds(ids: string[]): Promise<Map<string, StoredUser>> {
    await ready();
    const unique = [...new Set(ids)].filter(isObjectId);
    if (unique.length === 0) return new Map();
    const docs = await DriverUser.find({ _id: { $in: unique } }).lean<DriverUserDoc[]>();
    const map = new Map<string, StoredUser>();
    for (const doc of docs) {
      const user = toUser(doc);
      map.set(user.id, user);
    }
    return map;
  },

  /** As `findUserByIdTag`, batched for a transaction list — one query, not one per row. */
  async findUsersByIdTags(idTags: string[]): Promise<Map<string, StoredUser>> {
    await ready();
    const unique = [...new Set(idTags)];
    if (unique.length === 0) return new Map();
    const docs = await DriverUser.find({ idTag: { $in: unique } }).lean<DriverUserDoc[]>();
    const map = new Map<string, StoredUser>();
    for (const doc of docs) {
      const user = toUser(doc);
      if (user.idTag) map.set(user.idTag, user);
    }
    return map;
  },

  async createUser(input: NewUser): Promise<StoredUser> {
    await ready();
    const doc = await DriverUser.create({
      email: input.email?.toLowerCase(),
      phone: input.phone,
      phoneVerifiedAt: input.phoneVerifiedAt ? new Date(input.phoneVerifiedAt) : undefined,
      name: input.name,
      pinHash: input.pinHash,
      locale: input.locale ?? 'en',
      // A brand-new driver: every first-run guide is still to be shown.
      pendingGuides: [...DRIVER_GUIDES],
    });
    return toUser(doc.toObject() as unknown as DriverUserDoc);
  },

  async updateUser(id: string, patch: Partial<StoredUser>): Promise<StoredUser | null> {
    await ready();
    if (!isObjectId(id)) return null;
    const doc = await DriverUser.findByIdAndUpdate(id, toUpdate(patch), {
      new: true,
    }).lean<DriverUserDoc>();
    return doc ? toUser(doc) : null;
  },

  async createToken(input: NewToken): Promise<StoredToken> {
    await ready();
    const doc = await VerificationToken.create({ ...input });
    return toToken(doc.toObject() as unknown as VerificationTokenDoc);
  },

  async findTokenById(id: string): Promise<StoredToken | null> {
    await ready();
    if (!isObjectId(id)) return null;
    const doc = await VerificationToken.findById(id).lean<VerificationTokenDoc>();
    return doc ? toToken(doc) : null;
  },

  /** Unused, unexpired tokens for a user and kind, newest first. */
  async findActiveTokens(userId: string, kind: TokenKind): Promise<StoredToken[]> {
    await ready();
    const docs = await VerificationToken.find({
      userId,
      kind,
      usedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
    })
      .sort({ createdAt: -1 })
      .lean<VerificationTokenDoc[]>();
    return docs.map(toToken);
  },

  async markTokenUsed(id: string): Promise<void> {
    await ready();
    await VerificationToken.updateOne({ _id: id }, { $set: { usedAt: new Date() } });
  },

  async incrementTokenAttempts(id: string): Promise<number> {
    await ready();
    const doc = await VerificationToken.findByIdAndUpdate(
      id,
      { $inc: { attempts: 1 } },
      { new: true },
    ).lean<VerificationTokenDoc>();
    return doc?.attempts ?? 0;
  },

  async invalidateTokens(userId: string, kind: TokenKind): Promise<void> {
    await ready();
    await VerificationToken.updateMany(
      { userId, kind, usedAt: { $exists: false } },
      { $set: { usedAt: new Date() } },
    );
  },

  /** How many tokens of this kind were issued since `since` — used for throttling. */
  async countTokensSince(userId: string, kind: TokenKind, since: Date): Promise<number> {
    await ready();
    return VerificationToken.countDocuments({ userId, kind, createdAt: { $gte: since } });
  },
};

import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { DriverUser, getPhoneVariants, type DriverUserDoc } from '../../driver/store';
import { ChargePoint } from '../../models/ChargePoint';
import { IdTag } from '../../models/IdTag';
import { Transaction } from '../../models/Transaction';
import { Wallet, WalletEntry, type WalletDoc } from '../../models/Wallet';
import { Payment } from '../../models/Payment';
import { r2, reconcileLedger, signedAmount } from '../../services/driver-statement.service';
import {
  asyncHandler,
  paginate,
  paginationSchema,
  requireAuth,
  requireOperator,
  validate,
} from '../middleware';
import { badRequest, conflict, notFound } from '../../lib/errors';
import {
  bindIdTagToWallet,
  credit,
  findWallet,
  getOrCreateWallet,
  unbindIdTagFromWallet,
} from '../../services/wallet.service';
import { hashPin } from '../../driver/auth/pin';
import { hashPassword } from '../../models/User';

export const driversRouter = Router();
driversRouter.use(requireAuth);

const listDriversQuery = paginationSchema.extend({
  search: z.string().trim().optional(),
  status: z.enum(['all', 'active', 'blocked']).default('all'),
});

/**
 * GET /api/drivers
 * Returns paginated driver directory with wallet balance, tag count, and charging stats.
 */
driversRouter.get(
  '/',
  validate(listDriversQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listDriversQuery>;
    const filter: Record<string, unknown> = {};

    if ((req.user?.role === 'CLIENT' || req.user?.clientId) && req.user.clientId) {
      const clientOid = new Types.ObjectId(req.user.clientId);
      const [clientTags, txIdTags] = await Promise.all([
        IdTag.find({ walletOwnerType: 'CLIENT', walletOwnerId: String(clientOid) }).select('_id').lean(),
        Transaction.distinct('idTag', { clientId: clientOid }),
      ]);
      const allowedTags = [...new Set([...clientTags.map((t) => String(t._id)), ...txIdTags].filter(Boolean))];
      filter.idTag = { $in: allowedTags };
    }

    if (q.status === 'active') filter.isActive = true;
    else if (q.status === 'blocked') filter.isActive = false;

    if (q.search) {
      const regex = new RegExp(q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { name: regex },
        { phone: regex },
        { email: regex },
        { vehicleBrand: regex },
        { vehicleModel: regex },
        { idTag: regex },
      ];
    }

    const { skip, limit } = paginate(q);
    const [docs, total] = await Promise.all([
      DriverUser.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean<DriverUserDoc[]>(),
      DriverUser.countDocuments(filter),
    ]);

    const driverIds = docs.map((d) => String(d._id));

    // Bulk fetch wallets
    const wallets = await Wallet.find({
      ownerType: 'USER',
      ownerId: { $in: driverIds },
    }).lean<WalletDoc[]>();
    const walletMap = new Map<string, WalletDoc>();
    for (const w of wallets) {
      walletMap.set(w.ownerId, w);
    }

    // Bulk fetch RFID cards linked to these drivers
    const tags = await IdTag.find({
      $or: [
        { walletOwnerType: 'USER', walletOwnerId: { $in: driverIds } },
        { idTag: { $in: docs.map((d) => d.idTag).filter(Boolean) as string[] } },
      ],
    }).lean();
    const tagCountMap = new Map<string, number>();
    for (const t of tags) {
      if (t.walletOwnerId) {
        tagCountMap.set(t.walletOwnerId, (tagCountMap.get(t.walletOwnerId) ?? 0) + 1);
      }
    }

    // Aggregate sessions for driver tags
    const allKnownTags = Array.from(new Set(tags.map((t) => t._id)));
    const txAgg = await Transaction.aggregate([
      { $match: { idTag: { $in: allKnownTags } } },
      {
        $group: {
          _id: '$idTag',
          count: { $sum: 1 },
          energyWh: { $sum: '$energyWh' },
        },
      },
    ]);
    const txMap = new Map<string, { count: number; energyWh: number }>();
    for (const item of txAgg) {
      txMap.set(item._id, { count: item.count, energyWh: item.energyWh });
    }

    const data = docs.map((d) => {
      const id = String(d._id);
      const w = walletMap.get(id);
      const userTag = d.idTag;
      const txStats = userTag ? txMap.get(userTag) : undefined;

      return {
        id,
        name: d.name ?? 'Нэргүй жолооч',
        phone: d.phone ?? '',
        email: d.email ?? '',
        vehicleBrand: d.vehicleBrand ?? '',
        vehicleModel: d.vehicleModel ?? '',
        ebarimtCustomerNo: d.ebarimtCustomerNo ?? '',
        isActive: d.isActive,
        isInternal: Boolean(d.isInternal),
        idTag: d.idTag ?? null,
        wallet: {
          balance: w?.balance ?? 0,
          totalToppedUp: w?.totalToppedUp ?? 0,
          totalSpent: w?.totalSpent ?? 0,
          status: w?.status ?? 'ACTIVE',
        },
        rfidCardsCount: tagCountMap.get(id) ?? (d.idTag ? 1 : 0),
        sessionsCount: txStats?.count ?? 0,
        totalEnergyKwh: Number((((txStats?.energyWh ?? 0) as number) / 1000).toFixed(2)),
        createdAt: d.createdAt,
        lastLoginAt: d.lastLoginAt ?? null,
      };
    });

    const [walletAgg, txTotalAgg] = await Promise.all([
      Wallet.aggregate([
        { $match: { ownerType: 'USER' } },
        { $group: { _id: null, totalBalance: { $sum: '$balance' } } },
      ]),
      Transaction.countDocuments(),
    ]);

    const overallBalance = walletAgg[0]?.totalBalance ?? 0;
    const overallSessions = txTotalAgg;

    res.json({
      data,
      total,
      page: q.page,
      limit: q.limit,
      summary: {
        totalBalance: overallBalance,
        totalSessions: overallSessions,
      },
    });
  }),
);

/**
 * GET /api/drivers/:id
 * Returns detailed profile of a driver including wallet, RFID cards, and charging history.
 */
driversRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    let driver = Types.ObjectId.isValid(id) ? await DriverUser.findById(id).lean<DriverUserDoc>() : null;
    if (!driver) {
      const variants = getPhoneVariants(id);
      driver = await DriverUser.findOne({ phone: { $in: variants } }).lean<DriverUserDoc>();
    }
    if (!driver) throw notFound(`Жолооч олдсонгүй: ${id}`);

    const driverId = String(driver._id);

    // Fetch or initialize wallet
    const wallet = await getOrCreateWallet(
      { ownerType: 'USER', ownerId: driverId },
      { label: driver.name ?? driver.phone },
    );

    // Fetch all RFID tags for this driver
    const rfidCards = await IdTag.find({
      $or: [
        { walletOwnerType: 'USER', walletOwnerId: driverId },
        ...(driver.idTag ? [{ _id: driver.idTag }] : []),
        ...(driver.phone ? [{ ownerPhone: driver.phone }] : []),
      ],
    })
      .sort({ createdAt: -1 })
      .lean();

    const tagIds = Array.from(new Set([...rfidCards.map((c) => c._id), ...(driver.idTag ? [driver.idTag] : [])]));

    // Fetch driver's recent charging sessions
    const txMatch: Record<string, unknown> = { idTag: { $in: tagIds } };
    if ((req.user?.role === 'CLIENT' || req.user?.clientId) && req.user.clientId) {
      txMatch.clientId = new Types.ObjectId(req.user.clientId);
    }
    const recentSessions = await Transaction.find(txMatch)
      .populate('chargePointId', 'name cpId address')
      .sort({ startTimestamp: -1 })
      .limit(30)
      .lean();

    // Calculate all-time totals
    const agg = await Transaction.aggregate([
      { $match: txMatch },
      {
        $group: {
          _id: null,
          totalSessions: { $sum: 1 },
          totalEnergyWh: { $sum: '$energyWh' },
          totalCost: { $sum: '$cost' },
        },
      },
    ]);

    const stats = {
      totalSessions: agg[0]?.totalSessions ?? 0,
      totalEnergyWh: agg[0]?.totalEnergyWh ?? 0,
      totalEnergyKwh: Number((((agg[0]?.totalEnergyWh ?? 0) as number) / 1000).toFixed(2)),
      totalCost: agg[0]?.totalCost ?? 0,
    };

    res.json({
      driver: {
        id: String(driver._id),
        name: driver.name ?? 'Нэргүй жолооч',
        phone: driver.phone ?? '',
        email: driver.email ?? '',
        vehicleBrand: driver.vehicleBrand ?? '',
        vehicleModel: driver.vehicleModel ?? '',
        ebarimtCustomerNo: driver.ebarimtCustomerNo ?? '',
        isActive: driver.isActive,
        isInternal: Boolean(driver.isInternal),
        idTag: driver.idTag ?? null,
        locale: driver.locale ?? 'mn',
        createdAt: driver.createdAt,
        updatedAt: driver.updatedAt,
        lastLoginAt: driver.lastLoginAt ?? null,
      },
      wallet: {
        balance: wallet.balance,
        currency: wallet.currency,
        status: wallet.status,
        totalToppedUp: wallet.totalToppedUp,
        totalSpent: wallet.totalSpent,
        lastTopUpAt: wallet.lastTopUpAt,
        lastSpendAt: wallet.lastSpendAt,
      },
      rfidCards: rfidCards.map((c) => ({
        idTag: c._id,
        label: c.label ?? '',
        status: c.status,
        expiryDate: c.expiryDate,
        isInternal: c.isInternal,
        isPrimary: c._id === driver.idTag,
        allowedChargePointIds: c.allowedChargePointIds?.map((id: any) => String(id)) ?? [],
        createdAt: c.createdAt,
      })),
      stats,
      recentSessions: recentSessions.map((s: any) => ({
        id: s._id,
        stationName: s.chargePointId?.name ?? s.chargePointId?.cpId ?? 'Станц',
        connectorId: s.connectorId,
        idTag: s.idTag,
        status: s.status,
        startTimestamp: s.startTimestamp,
        stopTimestamp: s.stopTimestamp,
        energyWh: s.energyWh ?? 0,
        energyKwh: Number((((s.energyWh ?? 0) as number) / 1000).toFixed(2)),
        cost: s.cost ?? 0,
      })),
    });
  }),
);

/**
 * Resolves station identifiers (ObjectId hex, cpId, name, or sitePath)
 * into real ChargePoint._id ObjectIds for IdTag.allowedChargePointIds.
 * Silently drops unmatched or invalid strings to prevent Mongoose CastErrors.
 */
async function resolveAllowedStationObjectIds(
  inputs?: string[],
): Promise<Types.ObjectId[] | undefined> {
  if (!inputs || !Array.isArray(inputs) || inputs.length === 0) return undefined;
  const result: Types.ObjectId[] = [];
  for (const raw of inputs) {
    const val = String(raw).trim();
    if (!val) continue;

    if (Types.ObjectId.isValid(val) && /^[0-9a-fA-F]{24}$/.test(val)) {
      const oid = new Types.ObjectId(val);
      const exists = await ChargePoint.exists({ _id: oid });
      if (exists) {
        if (!result.some((r) => r.equals(oid))) result.push(oid);
        continue;
      }
    }

    const cp = await ChargePoint.findOne({
      $or: [{ cpId: val }, { name: val }, { sitePath: val }],
    }).select('_id');

    if (cp) {
      if (!result.some((r) => r.equals(cp._id))) result.push(cp._id);
    }
  }
  return result;
}

const createDriverSchema = z.object({
  phone: z.string().trim().min(8, 'Утасны дугаар дутуу байна'),
  name: z.string().trim().optional(),
  email: z.string().email('Имэйл хаяг буруу байна').optional().or(z.literal('')),
  password: z.string().trim().min(4, 'Нууц үг хамгийн багадаа 4 орон байна').optional().or(z.literal('')),
  vehicleBrand: z.string().trim().optional(),
  vehicleModel: z.string().trim().optional(),
  ebarimtCustomerNo: z.string().trim().optional(),
  isInternal: z.boolean().default(false),
  initialBalance: z.number().min(0).optional(),
  idTag: z.string().trim().optional().or(z.literal('')),
  tagStatus: z.enum(['Accepted', 'Blocked', 'Expired']).optional(),
  tagExpiryDate: z.string().optional(),
  allowedChargePointIds: z.array(z.string()).optional(),
});

/**
 * POST /api/drivers
 * Create a new driver profile with optional RFID tag and initial wallet balance.
 */
driversRouter.post(
  '/',
  requireOperator,
  validate(createDriverSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createDriverSchema>;

    const phoneVariants = getPhoneVariants(body.phone);
    const existing = await DriverUser.findOne({ phone: { $in: phoneVariants } });
    if (existing) {
      throw conflict(`Энэ утасны дугаартай жолооч аль хэдийн бүртгэгдсэн байна: ${body.phone}`);
    }

    if (body.email) {
      const emailExisting = await DriverUser.findOne({ email: body.email.toLowerCase() });
      if (emailExisting) {
        throw conflict(`Энэ имэйлтэй жолооч аль хэдийн бүртгэгдсэн байна: ${body.email}`);
      }
    }

    let pinHash: string | undefined;
    let passwordHash: string | undefined;
    if (body.password) {
      pinHash = await hashPin(body.password);
      passwordHash = await hashPassword(body.password);
    }

    const cleanTag = body.idTag?.trim() || undefined;

    const doc = await DriverUser.create({
      phone: body.phone,
      name: body.name?.trim() || undefined,
      email: body.email?.trim()?.toLowerCase() || undefined,
      pinHash,
      passwordHash,
      vehicleBrand: body.vehicleBrand?.trim() || undefined,
      vehicleModel: body.vehicleModel?.trim() || undefined,
      ebarimtCustomerNo: body.ebarimtCustomerNo?.trim() || undefined,
      isInternal: body.isInternal,
      idTag: cleanTag,
      isActive: true,
      locale: 'mn',
    });

    const driverId = String(doc._id);

    // Initialize wallet
    const wallet = await getOrCreateWallet(
      { ownerType: 'USER', ownerId: driverId },
      { label: body.name || body.phone },
    );

    if (body.initialBalance && body.initialBalance > 0) {
      await credit(
        { ownerType: 'USER', ownerId: driverId },
        body.initialBalance,
        'TOPUP',
        {
          idempotencyKey: `manual-topup-${driverId}-${Date.now()}`,
          description: 'Анхны үлдэгдэл нэмэв (Админ)',
          createdBy: req.user?.email || 'admin',
        },
      );
    }

    // Register / Bind RFID tag if provided
    if (cleanTag) {
      const allowedCps = await resolveAllowedStationObjectIds(body.allowedChargePointIds);
      const updateDoc: Record<string, unknown> = {
        status: body.tagStatus || 'Accepted',
        ownerName: body.name?.trim() || undefined,
        ownerPhone: body.phone,
        ownerEmail: body.email?.trim() || undefined,
        isInternal: body.isInternal,
        walletOwnerType: 'USER',
        walletOwnerId: driverId,
        ...(body.tagExpiryDate ? { expiryDate: new Date(body.tagExpiryDate) } : {}),
      };
      if (body.allowedChargePointIds !== undefined) {
        updateDoc.allowedChargePointIds = allowedCps ?? [];
      }
      await IdTag.findOneAndUpdate(
        { _id: cleanTag },
        {
          $set: updateDoc,
          $setOnInsert: {
            maxActiveTransactions: 1,
          },
        },
        { upsert: true, new: true },
      );
      await bindIdTagToWallet(cleanTag, { ownerType: 'USER', ownerId: driverId });
    }

    res.status(201).json({ id: driverId });
  }),
);

const updateDriverSchema = z.object({
  name: z.string().trim().optional(),
  phone: z.string().trim().min(8).optional(),
  email: z.string().email().optional().or(z.literal('')),
  password: z.string().trim().min(4, 'Нууц үг хамгийн багадаа 4 орон байна').optional().or(z.literal('')),
  vehicleBrand: z.string().trim().optional(),
  vehicleModel: z.string().trim().optional(),
  ebarimtCustomerNo: z.string().trim().optional(),
  isInternal: z.boolean().optional(),
  isActive: z.boolean().optional(),
  idTag: z.string().trim().optional().or(z.literal('')),
  tagStatus: z.enum(['Accepted', 'Blocked', 'Expired']).optional(),
  tagExpiryDate: z.string().optional(),
  allowedChargePointIds: z.array(z.string()).optional(),
});

/**
 * PATCH /api/drivers/:id
 * Update driver details.
 */
driversRouter.patch(
  '/:id',
  requireOperator,
  validate(updateDriverSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const body = req.body as z.infer<typeof updateDriverSchema>;

    let driver = Types.ObjectId.isValid(id) ? await DriverUser.findById(id) : null;
    if (!driver && body.phone) {
      const phoneVariants = getPhoneVariants(body.phone);
      driver = await DriverUser.findOne({ phone: { $in: phoneVariants } });
    }

    if (!driver) {
      if (!body.phone) {
        throw notFound(`Жолооч олдсонгүй: ${id}`);
      }
      // If driver was not in DB previously, create and save them directly into DB!
      let pinHash: string | undefined;
      let passwordHash: string | undefined;
      if (body.password) {
        pinHash = await hashPin(body.password);
        passwordHash = await hashPassword(body.password);
      }
      const cleanTag = body.idTag?.trim() || undefined;
      driver = new DriverUser({
        ...(Types.ObjectId.isValid(id) ? { _id: new Types.ObjectId(id) } : {}),
        phone: body.phone,
        name: body.name?.trim() || undefined,
        email: body.email?.trim()?.toLowerCase() || undefined,
        pinHash,
        passwordHash,
        vehicleBrand: body.vehicleBrand?.trim() || undefined,
        vehicleModel: body.vehicleModel?.trim() || undefined,
        ebarimtCustomerNo: body.ebarimtCustomerNo?.trim() || undefined,
        isInternal: body.isInternal ?? false,
        idTag: cleanTag,
        isActive: body.isActive ?? true,
        locale: 'mn',
      });
      await driver.save();
    }

    const driverId = String(driver._id);

    // Ensure wallet is created/active for this driver
    await getOrCreateWallet(
      { ownerType: 'USER', ownerId: driverId },
      { label: driver.name ?? driver.phone },
    );

    if (body.phone && body.phone !== driver.phone) {
      const phoneVariants = getPhoneVariants(body.phone);
      const clash = await DriverUser.findOne({ phone: { $in: phoneVariants }, _id: { $ne: driver._id } });
      if (clash) throw conflict(`Утасны дугаар давхардлаа: ${body.phone}`);
      driver.phone = body.phone;
    }

    if (body.email !== undefined) {
      const em = body.email?.trim()?.toLowerCase() || undefined;
      if (em && em !== driver.email) {
        const clash = await DriverUser.findOne({ email: em, _id: { $ne: driver._id } });
        if (clash) throw conflict(`Имэйл хаяг давхардлаа: ${em}`);
      }
      driver.email = em;
    }

    if (body.password) {
      driver.pinHash = await hashPin(body.password);
      driver.passwordHash = await hashPassword(body.password);
      driver.failedPinAttempts = 0;
      driver.pinLockedUntil = undefined as any;
    }

    if (body.name !== undefined) driver.name = body.name?.trim() || undefined;
    if (body.vehicleBrand !== undefined) driver.vehicleBrand = body.vehicleBrand?.trim() || undefined;
    if (body.vehicleModel !== undefined) driver.vehicleModel = body.vehicleModel?.trim() || undefined;
    if (body.ebarimtCustomerNo !== undefined) driver.ebarimtCustomerNo = body.ebarimtCustomerNo?.trim() || undefined;
    if (body.isInternal !== undefined) driver.isInternal = body.isInternal;
    if (body.isActive !== undefined) driver.isActive = body.isActive;

    if (body.idTag !== undefined) {
      const tag = body.idTag?.trim() || undefined;
      const oldTag = driver.idTag;
      driver.idTag = tag;
      if (oldTag && oldTag !== tag) {
        await unbindIdTagFromWallet(oldTag).catch(() => undefined);
      }
      if (tag) {
        const allowedCps = await resolveAllowedStationObjectIds(body.allowedChargePointIds);
        const updateDoc: Record<string, unknown> = {
          status: body.tagStatus || 'Accepted',
          ownerName: driver.name || undefined,
          ownerPhone: driver.phone,
          ownerEmail: driver.email || undefined,
          isInternal: body.isInternal ?? driver.isInternal,
          walletOwnerType: 'USER',
          walletOwnerId: driverId,
          ...(body.tagExpiryDate ? { expiryDate: new Date(body.tagExpiryDate) } : {}),
        };
        if (body.allowedChargePointIds !== undefined) {
          updateDoc.allowedChargePointIds = allowedCps ?? [];
        }
        await IdTag.findOneAndUpdate(
          { _id: tag },
          {
            $set: updateDoc,
            $setOnInsert: {
              maxActiveTransactions: 1,
            },
          },
          { upsert: true, new: true },
        );
        await bindIdTagToWallet(tag, { ownerType: 'USER', ownerId: driverId });
      }
    }

    await driver.save();
    res.json({ ok: true, id: driverId });
  }),
);

const bindTagSchema = z.object({
  idTag: z.string().trim().min(1, 'RFID картын дугаар оруулна уу'),
  label: z.string().trim().optional(),
  isInternal: z.boolean().default(false),
});

/**
 * POST /api/drivers/:id/rfid
 * Link an RFID tag to this driver.
 */
driversRouter.post(
  '/:id/rfid',
  requireOperator,
  validate(bindTagSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { idTag, label, isInternal } = req.body as z.infer<typeof bindTagSchema>;

    const driver = await DriverUser.findById(id);
    if (!driver) throw notFound(`Жолооч олдсонгүй: ${id}`);

    let tag = await IdTag.findById(idTag);
    if (!tag) {
      tag = await IdTag.create({
        _id: idTag,
        status: 'Accepted',
        label: label || `${driver.name ?? driver.phone} карт`,
        ownerName: driver.name,
        ownerPhone: driver.phone,
        ownerEmail: driver.email,
        isInternal: isInternal || Boolean(driver.isInternal),
        walletOwnerType: 'USER',
        walletOwnerId: id,
      });
    } else {
      tag.walletOwnerType = 'USER';
      tag.walletOwnerId = id;
      tag.ownerName = driver.name || tag.ownerName;
      tag.ownerPhone = driver.phone || tag.ownerPhone;
      tag.ownerEmail = driver.email || tag.ownerEmail;
      if (label) tag.label = label;
      tag.isInternal = isInternal || Boolean(driver.isInternal);
      await tag.save();
    }

    if (!driver.idTag) {
      driver.idTag = idTag;
      await driver.save();
    }

    res.json({ ok: true, idTag });
  }),
);

/**
 * DELETE /api/drivers/:id/rfid/:idTag
 * Unbind an RFID tag from this driver.
 */
driversRouter.delete(
  '/:id/rfid/:idTag',
  requireOperator,
  asyncHandler(async (req, res) => {
    const { id, idTag } = req.params;
    const driver = await DriverUser.findById(id);
    if (!driver) throw notFound(`Жолооч олдсонгүй: ${id}`);

    await unbindIdTagFromWallet(idTag);
    if (driver.idTag === idTag) {
      // Pick another tag if any exist
      const remaining = await IdTag.findOne({ walletOwnerType: 'USER', walletOwnerId: id });
      driver.idTag = remaining?._id || undefined;
      await driver.save();
    }

    res.json({ ok: true });
  }),
);

const walletAdjustSchema = z.object({
  amount: z.number().int().positive('Дүн 0-ээс их тоо байна'),
  type: z.enum(['TOPUP', 'BONUS', 'ADJUSTMENT']).default('TOPUP'),
  note: z.string().trim().min(1, 'Тайлбар оруулна уу'),
});

/**
 * POST /api/drivers/:id/wallet-adjust
 * Manual credit or balance adjustment for a driver.
 */
driversRouter.post(
  '/:id/wallet-adjust',
  requireOperator,
  validate(walletAdjustSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const body = req.body as z.infer<typeof walletAdjustSchema>;

    const driver = await DriverUser.findById(id);
    if (!driver) throw notFound(`Жолооч олдсонгүй: ${id}`);

    const resEntry = await credit(
      { ownerType: 'USER', ownerId: id },
      body.amount,
      body.type,
      {
        idempotencyKey: `manual-adj-${id}-${Date.now()}`,
        description: `${body.note} (${req.user?.email || 'admin'})`,
        createdBy: req.user?.email || 'admin',
      },
    );

    res.json({ ok: true, balance: resEntry.balance });
  }),
);

/**
 * DELETE /api/drivers/:id
 * Delete a driver user and unbind associated RFID tags.
 */
driversRouter.delete(
  '/:id',
  requireOperator,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const driver = await DriverUser.findById(id);
    if (!driver) throw notFound(`Жолооч олдсонгүй: ${id}`);

    // Unbind any IdTags associated with this driver
    await IdTag.updateMany(
      { walletOwnerType: 'USER', walletOwnerId: id },
      { $unset: { walletOwnerType: 1, walletOwnerId: 1, ownerPhone: 1, ownerName: 1 } },
    );
    if (driver.idTag) {
      await IdTag.updateOne(
        { _id: driver.idTag },
        { $unset: { walletOwnerType: 1, walletOwnerId: 1, ownerPhone: 1, ownerName: 1 } },
      );
    }

    await DriverUser.findByIdAndDelete(id);
    res.json({ ok: true, id });
  }),
);


const statementQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/**
 * GET /api/drivers/:id/statement?from=&to=
 * A driver's account statement: every charging session with the station it happened at,
 * a per-station breakdown, and the wallet ledger (top-ups, charges, refunds, adjustments)
 * reconciled from the opening balance to the closing balance.
 */
driversRouter.get(
  '/:id/statement',
  validate(statementQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof statementQuery>;
    const { id } = req.params;
    let driver = Types.ObjectId.isValid(id) ? await DriverUser.findById(id).lean<DriverUserDoc>() : null;
    if (!driver) {
      driver = await DriverUser.findOne({ phone: { $in: getPhoneVariants(id) } }).lean<DriverUserDoc>();
    }
    if (!driver) throw notFound(`Жолооч олдсонгүй: ${id}`);
    const driverId = String(driver._id);
    const clientScoped = Boolean((req.user?.role === 'CLIENT' || req.user?.clientId) && req.user?.clientId);

    const cards = await IdTag.find({
      $or: [
        { walletOwnerType: 'USER', walletOwnerId: driverId },
        ...(driver.idTag ? [{ _id: driver.idTag }] : []),
        ...(driver.phone ? [{ ownerPhone: driver.phone }] : []),
      ],
    })
      .select('_id label')
      .lean();
    const tagIds = [...new Set([...cards.map((c) => String(c._id)), ...(driver.idTag ? [driver.idTag] : [])])];

    // ---- Sessions -------------------------------------------------------
    const txMatch: Record<string, unknown> = { idTag: { $in: tagIds }, status: { $ne: 'Rejected' } };
    if (clientScoped) txMatch.clientId = new Types.ObjectId(String(req.user?.clientId));
    const startRange: Record<string, Date> = {};
    if (q.from) startRange.$gte = q.from;
    if (q.to) startRange.$lt = q.to;
    if (Object.keys(startRange).length) txMatch.startTimestamp = startRange;

    const txs = await Transaction.find(txMatch)
      .populate('chargePointId', 'name cpId address')
      .sort({ startTimestamp: 1 })
      .lean();

    // ---- Wallet ledger --------------------------------------------------
    const owner = { ownerType: 'USER', ownerId: driverId };
    const wallet = await Wallet.findOne(owner).lean();
    const entryMatch: Record<string, unknown> = { ...owner };
    const createdRange: Record<string, Date> = {};
    if (q.from) createdRange.$gte = q.from;
    if (q.to) createdRange.$lt = q.to;
    if (Object.keys(createdRange).length) entryMatch.createdAt = createdRange;

    const [entries, lastBefore] = await Promise.all([
      clientScoped ? Promise.resolve([]) : WalletEntry.find(entryMatch).sort({ createdAt: 1, _id: 1 }).lean(),
      !clientScoped && q.from
        ? WalletEntry.findOne({ ...owner, createdAt: { $lt: q.from } }).sort({ createdAt: -1, _id: -1 }).lean()
        : Promise.resolve(null),
    ]);

    // Which sessions were paid from the wallet, and which by a direct payment (QPay etc.)
    const txIds = txs.map((t) => t._id);
    const [txCharges, directPayments, topupPayments] = await Promise.all([
      // Net wallet charge per session: CHARGE debits minus any REFUND credited back for it.
      WalletEntry.find({ ...owner, type: { $in: ['CHARGE', 'REFUND'] }, transactionId: { $in: txIds } })
        .select('transactionId type amount')
        .lean(),
      Payment.find({ transactionId: { $in: txIds }, status: 'PAID' }).select('transactionId provider paidAmount').lean(),
      Payment.find({ _id: { $in: entries.map((e) => e.paymentId).filter((p) => p && Types.ObjectId.isValid(p)) } })
        .select('provider')
        .lean(),
    ]);
    const walletPaidByTx = new Map<number, number>();
    for (const e of txCharges) {
      if (e.transactionId != null) walletPaidByTx.set(e.transactionId, (walletPaidByTx.get(e.transactionId) ?? 0) - signedAmount(e));
    }
    const directByTx = new Map(directPayments.map((p) => [p.transactionId as number, p]));
    const providerByPayment = new Map(topupPayments.map((p) => [String(p._id), p.provider]));

    const stationName = (cp: unknown) => {
      const c = cp as { name?: string; cpId?: string } | null;
      return c?.name ?? c?.cpId ?? 'Станц';
    };

    const sessions = txs.map((t) => {
      const walletPaid = r2(walletPaidByTx.get(t._id) ?? 0);
      const direct = directByTx.get(t._id);
      const cost = r2(t.cost ?? 0);
      const paidBy = walletPaid > 0 ? 'Хэтэвч' : direct ? direct.provider : cost === 0 ? 'Төлбөргүй' : 'Тодорхойгүй';
      return {
        id: t._id,
        stationId: String((t.chargePointId as { _id?: unknown })?._id ?? t.chargePointId),
        stationName: stationName(t.chargePointId),
        cpId: (t.chargePointId as { cpId?: string })?.cpId ?? '',
        connectorId: t.connectorId,
        idTag: t.idTag,
        status: t.status,
        startTimestamp: t.startTimestamp,
        stopTimestamp: t.stopTimestamp ?? null,
        energyKwh: r2((t.energyWh ?? 0) / 1000),
        tariffPerKwh: t.tariffPerKwh ?? null,
        cost,
        refundAmount: t.refund?.amount != null ? r2(t.refund.amount) : 0,
        paidBy,
        walletPaid,
        directPaid: direct ? r2(direct.paidAmount ?? 0) : 0,
      };
    });

    const byStationMap = new Map<string, { stationId: string; stationName: string; cpId: string; sessions: number; energyKwh: number; cost: number; first: Date; last: Date }>();
    for (const s of sessions) {
      const b = byStationMap.get(s.stationId) ?? {
        stationId: s.stationId,
        stationName: s.stationName,
        cpId: s.cpId,
        sessions: 0,
        energyKwh: 0,
        cost: 0,
        first: s.startTimestamp,
        last: s.startTimestamp,
      };
      b.sessions += 1;
      b.energyKwh = r2(b.energyKwh + s.energyKwh);
      b.cost = r2(b.cost + s.cost);
      if (s.startTimestamp < b.first) b.first = s.startTimestamp;
      if (s.startTimestamp > b.last) b.last = s.startTimestamp;
      byStationMap.set(s.stationId, b);
    }
    const byStation = [...byStationMap.values()].sort((a, b) => b.cost - a.cost);

    const { rows, summary } = reconcileLedger(entries, lastBefore?.balanceAfter ?? 0);
    const stationByTx = new Map(sessions.map((s) => [s.id, s.stationName]));
    const ledger = rows.map((row) => ({
      ...row,
      stationName: row.transactionId != null ? (stationByTx.get(row.transactionId) ?? '') : '',
      provider: row.paymentId ? (providerByPayment.get(String(row.paymentId)) ?? '') : '',
    }));
    const rangeReachesNow = !q.to || q.to.getTime() >= Date.now();

    res.json({
      driver: {
        id: driverId,
        name: driver.name ?? 'Нэргүй жолооч',
        phone: driver.phone ?? '',
        email: clientScoped ? '' : (driver.email ?? ''),
        vehicle: [driver.vehicleBrand, driver.vehicleModel].filter(Boolean).join(' '),
        isInternal: Boolean(driver.isInternal),
        cards: tagIds,
        createdAt: driver.createdAt,
      },
      period: { from: q.from ?? null, to: q.to ?? null },
      walletHidden: clientScoped,
      totals: {
        sessions: sessions.length,
        stations: byStation.length,
        energyKwh: r2(sessions.reduce((a, s) => a + s.energyKwh, 0)),
        cost: r2(sessions.reduce((a, s) => a + s.cost, 0)),
        paidFromWallet: r2(sessions.reduce((a, s) => a + s.walletPaid, 0)),
        paidDirect: r2(sessions.reduce((a, s) => a + s.directPaid, 0)),
        unknownPayment: sessions.filter((s) => s.paidBy === 'Тодорхойгүй').length,
      },
      wallet: clientScoped
        ? null
        : {
            ...summary,
            currentBalance: r2(wallet?.balance ?? 0),
            // Only comparable when the period runs up to today.
            currentMatchesLedger: rangeReachesNow
              ? Math.abs((wallet?.balance ?? 0) - summary.closingBalance) < 0.01
              : null,
            lifetimeToppedUp: r2(wallet?.totalToppedUp ?? 0),
            lifetimeSpent: r2(wallet?.totalSpent ?? 0),
          },
      byStation,
      sessions,
      ledger,
    });
  }),
);

const bulkStatementQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** Only drivers who charged at this station in the period (their other stations still show). */
  chargePointId: z.string().trim().optional(),
});

/**
 * GET /api/drivers/export/statements?from=&to=&chargePointId=
 * Statements for many drivers at once: per-driver totals and wallet reconciliation,
 * a driver × station breakdown, every session and every wallet movement, each row
 * tagged with its driver. Operators and admins only (it exposes every wallet).
 */
driversRouter.get(
  '/export/statements',
  requireOperator,
  validate(bulkStatementQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof bulkStatementQuery>;
    const range: Record<string, Date> = {};
    if (q.from) range.$gte = q.from;
    if (q.to) range.$lt = q.to;
    const hasRange = Object.keys(range).length > 0;

    let station: { id: string; name: string; cpId: string } | null = null;
    if (q.chargePointId) {
      const cp = await ChargePoint.findOne(
        Types.ObjectId.isValid(q.chargePointId) ? { _id: q.chargePointId } : { cpId: q.chargePointId },
      )
        .select('name cpId')
        .lean();
      if (!cp) throw badRequest('Charge point not found');
      station = { id: String(cp._id), name: cp.name ?? cp.cpId, cpId: cp.cpId };
    }

    // ---- Drivers and the charge tags that belong to them ----------------
    const drivers = await DriverUser.find({})
      .select('name phone email idTag vehicleBrand vehicleModel isInternal')
      .lean<DriverUserDoc[]>();
    const driverById = new Map(drivers.map((d) => [String(d._id), d]));
    const driverByPhone = new Map(drivers.filter((d) => d.phone).map((d) => [String(d.phone), String(d._id)]));
    const tagToDriver = new Map<string, string>();
    for (const d of drivers) if (d.idTag) tagToDriver.set(d.idTag, String(d._id));
    const tagDocs = await IdTag.find({
      $or: [{ walletOwnerType: 'USER' }, { ownerPhone: { $in: [...driverByPhone.keys()] } }],
    })
      .select('_id walletOwnerType walletOwnerId ownerPhone')
      .lean();
    for (const t of tagDocs) {
      const byWallet = t.walletOwnerType === 'USER' && t.walletOwnerId && driverById.has(t.walletOwnerId) ? t.walletOwnerId : undefined;
      const owner = byWallet ?? (t.ownerPhone ? driverByPhone.get(t.ownerPhone) : undefined);
      if (owner && !tagToDriver.has(String(t._id))) tagToDriver.set(String(t._id), owner);
    }

    // ---- Which drivers are in scope ---------------------------------------
    let scopedDriverIds: Set<string> | null = null;
    if (station) {
      const tagsHere: string[] = await Transaction.distinct('idTag', {
        chargePointId: new Types.ObjectId(station.id),
        status: { $ne: 'Rejected' },
        ...(hasRange ? { startTimestamp: range } : {}),
      });
      scopedDriverIds = new Set(tagsHere.map((t) => tagToDriver.get(t)).filter((x): x is string => Boolean(x)));
    }
    const inScope = (driverId: string) => !scopedDriverIds || scopedDriverIds.has(driverId);
    const scopedTags = [...tagToDriver.entries()].filter(([, d]) => inScope(d)).map(([t]) => t);
    const scopedIds = drivers.map((d) => String(d._id)).filter(inScope);

    // ---- Sessions --------------------------------------------------------
    const txs = await Transaction.find({
      idTag: { $in: scopedTags },
      status: { $ne: 'Rejected' },
      ...(hasRange ? { startTimestamp: range } : {}),
    })
      .populate('chargePointId', 'name cpId')
      .sort({ startTimestamp: 1 })
      .lean();

    // ---- Wallet ledger ---------------------------------------------------
    const [wallets, entries, openings] = await Promise.all([
      Wallet.find({ ownerType: 'USER', ownerId: { $in: scopedIds } }).lean(),
      WalletEntry.find({ ownerType: 'USER', ownerId: { $in: scopedIds }, ...(hasRange ? { createdAt: range } : {}) })
        .sort({ createdAt: 1, _id: 1 })
        .lean(),
      q.from
        ? WalletEntry.aggregate<{ _id: string; balanceAfter: number }>([
            { $match: { ownerType: 'USER', ownerId: { $in: scopedIds }, createdAt: { $lt: q.from } } },
            { $sort: { createdAt: -1, _id: -1 } },
            { $group: { _id: '$ownerId', balanceAfter: { $first: '$balanceAfter' } } },
          ])
        : Promise.resolve([]),
    ]);
    const walletByOwner = new Map(wallets.map((w) => [w.ownerId, w]));
    const openingByOwner = new Map(openings.map((o) => [o._id, o.balanceAfter]));

    const txIds = txs.map((t) => t._id);
    const [txCharges, directPayments, topupPayments] = await Promise.all([
      // Net wallet charge per session: CHARGE debits minus any REFUND credited back for it.
      WalletEntry.find({ ownerType: 'USER', type: { $in: ['CHARGE', 'REFUND'] }, transactionId: { $in: txIds } })
        .select('transactionId type amount')
        .lean(),
      Payment.find({ transactionId: { $in: txIds }, status: 'PAID' }).select('transactionId provider paidAmount').lean(),
      Payment.find({ _id: { $in: entries.map((e) => e.paymentId).filter((p) => p && Types.ObjectId.isValid(p)) } })
        .select('provider')
        .lean(),
    ]);
    const walletPaidByTx = new Map<number, number>();
    for (const e of txCharges) {
      if (e.transactionId != null) walletPaidByTx.set(e.transactionId, (walletPaidByTx.get(e.transactionId) ?? 0) - signedAmount(e));
    }
    const directByTx = new Map(directPayments.map((p) => [p.transactionId as number, p]));
    const providerByPayment = new Map(topupPayments.map((p) => [String(p._id), p.provider]));

    const sessions = txs.map((t) => {
      const cp = t.chargePointId as unknown as { _id?: unknown; name?: string; cpId?: string } | null;
      const driverId = tagToDriver.get(t.idTag) ?? '';
      const d = driverById.get(driverId);
      const walletPaid = r2(walletPaidByTx.get(t._id) ?? 0);
      const direct = directByTx.get(t._id);
      const cost = r2(t.cost ?? 0);
      return {
        id: t._id,
        driverId,
        driverName: d?.name ?? '',
        driverPhone: d?.phone ?? '',
        stationId: String(cp?._id ?? ''),
        stationName: cp?.name ?? cp?.cpId ?? 'Станц',
        cpId: cp?.cpId ?? '',
        connectorId: t.connectorId,
        idTag: t.idTag,
        status: t.status,
        startTimestamp: t.startTimestamp,
        stopTimestamp: t.stopTimestamp ?? null,
        energyKwh: r2((t.energyWh ?? 0) / 1000),
        tariffPerKwh: t.tariffPerKwh ?? null,
        cost,
        refundAmount: t.refund?.amount != null ? r2(t.refund.amount) : 0,
        paidBy: walletPaid > 0 ? 'Хэтэвч' : direct ? direct.provider : cost === 0 ? 'Төлбөргүй' : 'Тодорхойгүй',
        walletPaid,
        directPaid: direct ? r2(direct.paidAmount ?? 0) : 0,
      };
    });
    const stationByTx = new Map(sessions.map((s) => [s.id, s.stationName]));

    const sessionsByDriver = new Map<string, typeof sessions>();
    for (const s of sessions) {
      const list = sessionsByDriver.get(s.driverId) ?? [];
      list.push(s);
      sessionsByDriver.set(s.driverId, list);
    }
    const entriesByDriver = new Map<string, typeof entries>();
    for (const e of entries) {
      const list = entriesByDriver.get(e.ownerId) ?? [];
      list.push(e);
      entriesByDriver.set(e.ownerId, list);
    }

    const rangeReachesNow = !q.to || q.to.getTime() >= Date.now();
    const ledger: Record<string, unknown>[] = [];
    const driverRows = scopedIds
      .map((driverId) => {
        const d = driverById.get(driverId)!;
        const own = sessionsByDriver.get(driverId) ?? [];
        const ownEntries = entriesByDriver.get(driverId) ?? [];
        const wallet = walletByOwner.get(driverId);
        if (!own.length && !ownEntries.length && (station || !(wallet?.balance ?? 0))) return null;

        const { rows, summary } = reconcileLedger(ownEntries, openingByOwner.get(driverId) ?? 0);
        for (const row of rows) {
          ledger.push({
            ...row,
            driverId,
            driverName: d.name ?? '',
            driverPhone: d.phone ?? '',
            stationName: row.transactionId != null ? (stationByTx.get(row.transactionId) ?? '') : '',
            provider: row.paymentId ? (providerByPayment.get(String(row.paymentId)) ?? '') : '',
          });
        }

        const perStation = new Map<string, { stationName: string; cpId: string; sessions: number; energyKwh: number; cost: number }>();
        for (const s of own) {
          const b = perStation.get(s.stationId) ?? { stationName: s.stationName, cpId: s.cpId, sessions: 0, energyKwh: 0, cost: 0 };
          b.sessions += 1;
          b.energyKwh = r2(b.energyKwh + s.energyKwh);
          b.cost = r2(b.cost + s.cost);
          perStation.set(s.stationId, b);
        }
        const currentBalance = r2(wallet?.balance ?? 0);
        return {
          id: driverId,
          name: d.name ?? 'Нэргүй жолооч',
          phone: d.phone ?? '',
          email: d.email ?? '',
          vehicle: [d.vehicleBrand, d.vehicleModel].filter(Boolean).join(' '),
          isInternal: Boolean(d.isInternal),
          cards: [...tagToDriver.entries()].filter(([, o]) => o === driverId).map(([t]) => t),
          sessions: own.length,
          energyKwh: r2(own.reduce((a, s) => a + s.energyKwh, 0)),
          cost: r2(own.reduce((a, s) => a + s.cost, 0)),
          paidFromWallet: r2(own.reduce((a, s) => a + s.walletPaid, 0)),
          paidDirect: r2(own.reduce((a, s) => a + s.directPaid, 0)),
          unknownPayment: own.filter((s) => s.paidBy === 'Тодорхойгүй').length,
          stations: [...perStation.values()].sort((a, b) => b.cost - a.cost),
          wallet: {
            ...summary,
            currentBalance,
            currentMatchesLedger: rangeReachesNow
              ? ownEntries.length || q.from
                ? Math.abs(currentBalance - summary.closingBalance) < 0.01
                : currentBalance === 0
              : null,
          },
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.cost - a.cost);

    const included = new Set(driverRows.map((d) => d.id));
    res.json({
      period: { from: q.from ?? null, to: q.to ?? null },
      station,
      drivers: driverRows,
      sessions: sessions.filter((s) => included.has(s.driverId)),
      ledger: ledger.filter((l) => included.has(String(l.driverId))),
    });
  }),
);

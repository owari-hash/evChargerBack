import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { DriverUser, type DriverUserDoc } from '../../driver/store';
import { IdTag } from '../../models/IdTag';
import { Transaction } from '../../models/Transaction';
import { Wallet, type WalletDoc } from '../../models/Wallet';
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

    res.json({ data, total, page: q.page, limit: q.limit });
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
    if (!Types.ObjectId.isValid(id)) throw notFound(`Жолооч олдсонгүй: ${id}`);

    const driver = await DriverUser.findById(id).lean<DriverUserDoc>();
    if (!driver) throw notFound(`Жолооч олдсонгүй: ${id}`);

    // Fetch or initialize wallet
    const wallet = await getOrCreateWallet(
      { ownerType: 'USER', ownerId: id },
      { label: driver.name ?? driver.phone },
    );

    // Fetch all RFID tags for this driver
    const rfidCards = await IdTag.find({
      $or: [
        { walletOwnerType: 'USER', walletOwnerId: id },
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

const createDriverSchema = z.object({
  phone: z.string().trim().min(8, 'Утасны дугаар дутуу байна'),
  name: z.string().trim().optional(),
  email: z.string().email('Имэйл хаяг буруу байна').optional().or(z.literal('')),
  vehicleBrand: z.string().trim().optional(),
  vehicleModel: z.string().trim().optional(),
  ebarimtCustomerNo: z.string().trim().optional(),
  isInternal: z.boolean().default(false),
  initialBalance: z.number().min(0).optional(),
  idTag: z.string().trim().optional(),
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

    const existing = await DriverUser.findOne({ phone: body.phone });
    if (existing) {
      throw conflict(`Энэ утасны дугаартай жолооч аль хэдийн бүртгэгдсэн байна: ${body.phone}`);
    }

    if (body.email) {
      const emailExisting = await DriverUser.findOne({ email: body.email.toLowerCase() });
      if (emailExisting) {
        throw conflict(`Энэ имэйлтэй жолооч аль хэдийн бүртгэгдсэн байна: ${body.email}`);
      }
    }

    const doc = await DriverUser.create({
      phone: body.phone,
      name: body.name?.trim() || undefined,
      email: body.email?.trim()?.toLowerCase() || undefined,
      vehicleBrand: body.vehicleBrand?.trim() || undefined,
      vehicleModel: body.vehicleModel?.trim() || undefined,
      ebarimtCustomerNo: body.ebarimtCustomerNo?.trim() || undefined,
      isInternal: body.isInternal,
      idTag: body.idTag?.trim() || undefined,
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

    // Bind RFID tag if provided
    if (body.idTag) {
      await bindIdTagToWallet(body.idTag, { ownerType: 'USER', ownerId: driverId });
      await IdTag.updateOne(
        { _id: body.idTag },
        {
          $set: {
            ownerName: body.name || undefined,
            ownerPhone: body.phone,
            ownerEmail: body.email || undefined,
            isInternal: body.isInternal,
          },
        },
      );
    }

    res.status(201).json({ id: driverId });
  }),
);

const updateDriverSchema = z.object({
  name: z.string().trim().optional(),
  phone: z.string().trim().min(8).optional(),
  email: z.string().email().optional().or(z.literal('')),
  vehicleBrand: z.string().trim().optional(),
  vehicleModel: z.string().trim().optional(),
  ebarimtCustomerNo: z.string().trim().optional(),
  isInternal: z.boolean().optional(),
  isActive: z.boolean().optional(),
  idTag: z.string().trim().optional().or(z.literal('')),
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

    const driver = await DriverUser.findById(id);
    if (!driver) throw notFound(`Жолооч олдсонгүй: ${id}`);

    if (body.phone && body.phone !== driver.phone) {
      const clash = await DriverUser.findOne({ phone: body.phone, _id: { $ne: driver._id } });
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

    if (body.name !== undefined) driver.name = body.name?.trim() || undefined;
    if (body.vehicleBrand !== undefined) driver.vehicleBrand = body.vehicleBrand?.trim() || undefined;
    if (body.vehicleModel !== undefined) driver.vehicleModel = body.vehicleModel?.trim() || undefined;
    if (body.ebarimtCustomerNo !== undefined) driver.ebarimtCustomerNo = body.ebarimtCustomerNo?.trim() || undefined;
    if (body.isInternal !== undefined) driver.isInternal = body.isInternal;
    if (body.isActive !== undefined) driver.isActive = body.isActive;

    if (body.idTag !== undefined) {
      const tag = body.idTag?.trim() || undefined;
      driver.idTag = tag;
      if (tag) {
        await bindIdTagToWallet(tag, { ownerType: 'USER', ownerId: id });
      }
    }

    await driver.save();
    res.json({ ok: true, id });
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


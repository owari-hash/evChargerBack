import { Router } from 'express';
import { z } from 'zod';
import { badRequest, conflict, notFound } from '../../lib/errors';
import {
  PartnerMerchant,
  hashPartnerPassword,
} from '../../models/PartnerMerchant';
import { PartnerApiLog } from '../../models/PartnerApiLog';
import { revokeAllPartnerTokens } from '../middleware/partnerAuth';
import {
  asyncHandler,
  requireAuth,
  requireOperator,
  validate,
  paginationSchema,
  paginate,
} from '../middleware';

export const partnerMerchantsRouter = Router();
partnerMerchantsRouter.use(requireAuth, requireOperator);

// ---------------------------------------------------------------------------
// 1. Stats Summary
// ---------------------------------------------------------------------------

partnerMerchantsRouter.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [total, active, todayCalls, errorCalls] = await Promise.all([
      PartnerMerchant.countDocuments(),
      PartnerMerchant.countDocuments({ isActive: true }),
      PartnerApiLog.countDocuments({ createdAt: { $gte: todayStart } }),
      PartnerApiLog.countDocuments({ createdAt: { $gte: todayStart }, statusCode: { $gte: 400 } }),
    ]);

    const successRate = todayCalls > 0 ? Math.round(((todayCalls - errorCalls) / todayCalls) * 100) : 100;

    res.json({
      totalMerchants: total,
      activeMerchants: active,
      inactiveMerchants: total - active,
      todayApiCalls: todayCalls,
      successRate,
    });
  }),
);

// ---------------------------------------------------------------------------
// 2. Global API Call Logs
// ---------------------------------------------------------------------------

partnerMerchantsRouter.get(
  '/logs/all',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const merchantId = req.query.merchantId as string;
    const status = req.query.status as string; // 'all', 'success', 'error'
    const search = (req.query.search as string)?.trim();

    const filter: Record<string, unknown> = {};

    if (merchantId && merchantId !== 'all') {
      filter.merchantId = merchantId;
    }

    if (status === 'success') {
      filter.statusCode = { $lt: 400 };
    } else if (status === 'error') {
      filter.statusCode = { $gte: 400 };
    }

    if (search) {
      filter.$or = [
        { endpoint: { $regex: search, $options: 'i' } },
        { merchantName: { $regex: search, $options: 'i' } },
        { merchantUsername: { $regex: search, $options: 'i' } },
        { ip: { $regex: search, $options: 'i' } },
      ];
    }

    const [items, total] = await Promise.all([
      PartnerApiLog.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      PartnerApiLog.countDocuments(filter),
    ]);

    res.json({
      items: items.map((log) => ({
        id: String(log._id),
        merchantId: String(log.merchantId),
        merchantName: log.merchantName,
        merchantUsername: log.merchantUsername,
        method: log.method,
        endpoint: log.endpoint,
        statusCode: log.statusCode,
        durationMs: log.durationMs,
        ip: log.ip,
        userAgent: log.userAgent,
        requestQuery: log.requestQuery,
        requestBody: log.requestBody,
        errorMessage: log.errorMessage,
        createdAt: log.createdAt,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  }),
);

// ---------------------------------------------------------------------------
// 3. List Merchants (Paginated with search)
// ---------------------------------------------------------------------------

const listQuerySchema = paginationSchema.extend({
  search: z.string().optional(),
  status: z.enum(['all', 'active', 'inactive']).default('all'),
});

partnerMerchantsRouter.get(
  '/',
  validate(listQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuerySchema>;
    const filter: Record<string, unknown> = {};

    if (q.status === 'active') filter.isActive = true;
    if (q.status === 'inactive') filter.isActive = false;

    if (q.search?.trim()) {
      const rx = new RegExp(q.search.trim(), 'i');
      filter.$or = [{ name: rx }, { code: rx }, { username: rx }, { contactName: rx }, { contactPhone: rx }];
    }

    const [merchants, total] = await Promise.all([
      PartnerMerchant.find(filter)
        .populate('clientId', 'name businessRegister feePercent')
        .sort({ createdAt: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit)
        .lean(),
      PartnerMerchant.countDocuments(filter),
    ]);

    // Fetch today's API call counts for each merchant
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const merchantIds = merchants.map((m) => m._id);
    const todayCounts = await PartnerApiLog.aggregate([
      { $match: { merchantId: { $in: merchantIds }, createdAt: { $gte: todayStart } } },
      { $group: { _id: '$merchantId', count: { $sum: 1 } } },
    ]);

    const countMap = new Map<string, number>();
    todayCounts.forEach((c) => countMap.set(String(c._id), c.count));

    res.json({
      items: merchants.map((m) => ({
        id: String(m._id),
        name: m.name,
        code: m.code,
        username: m.username,
        client: m.clientId,
        allowedStations: m.allowedStations || [],
        allowedScopes: m.allowedScopes || [],
        isActive: m.isActive,
        ipWhitelist: m.ipWhitelist || [],
        rateLimitPerMin: m.rateLimitPerMin || 120,
        contactName: m.contactName,
        contactPhone: m.contactPhone,
        contactEmail: m.contactEmail,
        description: m.description,
        lastLoginAt: m.lastLoginAt,
        lastActiveAt: m.lastActiveAt,
        totalApiCalls: m.totalApiCalls || 0,
        todayApiCalls: countMap.get(String(m._id)) || 0,
        createdAt: m.createdAt,
      })),
      total,
      page: q.page,
      limit: q.limit,
      totalPages: Math.ceil(total / q.limit),
    });
  }),
);

// ---------------------------------------------------------------------------
// 4. Single Merchant Detail
// ---------------------------------------------------------------------------

partnerMerchantsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const merchant = await PartnerMerchant.findById(req.params.id)
      .populate('clientId', 'name businessRegister')
      .lean();
    if (!merchant) throw notFound('Мерчант олдсонгүй');

    res.json({
      id: String(merchant._id),
      name: merchant.name,
      code: merchant.code,
      username: merchant.username,
      client: merchant.clientId,
      allowedStations: merchant.allowedStations || [],
      allowedScopes: merchant.allowedScopes || [],
      isActive: merchant.isActive,
      ipWhitelist: merchant.ipWhitelist || [],
      rateLimitPerMin: merchant.rateLimitPerMin || 120,
      contactName: merchant.contactName,
      contactPhone: merchant.contactPhone,
      contactEmail: merchant.contactEmail,
      description: merchant.description,
      lastLoginAt: merchant.lastLoginAt,
      lastActiveAt: merchant.lastActiveAt,
      totalApiCalls: merchant.totalApiCalls || 0,
      createdAt: merchant.createdAt,
    });
  }),
);

// ---------------------------------------------------------------------------
// 5. Create Merchant
// ---------------------------------------------------------------------------

const createMerchantSchema = z.object({
  name: z.string().min(2, 'Нэр хамгийн багадаа 2 тэмдэгт байна'),
  code: z
    .string()
    .min(2, 'Код хамгийн багадаа 2 тэмдэгт байна')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Зөвхөн үсэг, тоо, зураас ашиглана'),
  username: z
    .string()
    .min(3, 'Хэрэглэгчийн нэр хамгийн багадаа 3 тэмдэгт байна')
    .regex(/^[a-zA-Z0-9_.-]+$/, 'Зөвхөн үсэг, тоо, цэг, зураас ашиглана'),
  password: z.string().min(6, 'Нууц үг хамгийн багадаа 6 тэмдэгт байна'),
  clientId: z.string().optional().nullable(),
  allowedStations: z.array(z.string()).default([]),
  allowedScopes: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
  ipWhitelist: z.array(z.string()).default([]),
  contactName: z.string().optional(),
  contactPhone: z.string().optional(),
  contactEmail: z.string().email().optional().or(z.literal('')),
  description: z.string().optional(),
});

partnerMerchantsRouter.post(
  '/',
  validate(createMerchantSchema),
  asyncHandler(async (req, res) => {
    const data = req.body as z.infer<typeof createMerchantSchema>;

    const code = data.code.trim().toLowerCase();
    const username = data.username.trim().toLowerCase();

    // Check code / username uniqueness
    const existing = await PartnerMerchant.findOne({
      $or: [{ code }, { username }],
    });

    if (existing) {
      if (existing.code === code) throw conflict(`"${code}" кодтой мерчант аль хэдийн бүртгэгдсэн байна`);
      if (existing.username === username) throw conflict(`"${username}" нэвтрэх нэр аль хэдийн ашиглагдаж байна`);
    }

    const passwordHash = await hashPartnerPassword(data.password);

    const merchant = await PartnerMerchant.create({
      name: data.name.trim(),
      code,
      username,
      passwordHash,
      clientId: data.clientId || undefined,
      allowedStations: data.allowedStations || [],
      allowedScopes: data.allowedScopes && data.allowedScopes.length > 0
        ? data.allowedScopes
        : ['stations:read', 'connectors:read', 'sessions:read', 'sessions:control', 'tariffs:read'],
      isActive: data.isActive,
      ipWhitelist: data.ipWhitelist ? data.ipWhitelist.map((ip) => ip.trim()).filter(Boolean) : [],
      contactName: data.contactName?.trim(),
      contactPhone: data.contactPhone?.trim(),
      contactEmail: data.contactEmail?.trim() || undefined,
      description: data.description?.trim(),
    });

    res.status(201).json(merchant.toJSON());
  }),
);

// ---------------------------------------------------------------------------
// 6. Update Merchant
// ---------------------------------------------------------------------------

const updateMerchantSchema = z.object({
  name: z.string().min(2).optional(),
  code: z
    .string()
    .min(2)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
  username: z
    .string()
    .min(3)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .optional(),
  clientId: z.string().optional().nullable(),
  allowedStations: z.array(z.string()).optional(),
  allowedScopes: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
  ipWhitelist: z.array(z.string()).optional(),
  contactName: z.string().optional(),
  contactPhone: z.string().optional(),
  contactEmail: z.string().email().optional().or(z.literal('')),
  description: z.string().optional(),
});

partnerMerchantsRouter.put(
  '/:id',
  validate(updateMerchantSchema),
  asyncHandler(async (req, res) => {
    const data = req.body as z.infer<typeof updateMerchantSchema>;
    const id = req.params.id;

    const merchant = await PartnerMerchant.findById(id);
    if (!merchant) throw notFound('Мерчант олдсонгүй');

    if (data.code && data.code.toLowerCase() !== merchant.code) {
      const codeTaken = await PartnerMerchant.findOne({ code: data.code.toLowerCase(), _id: { $ne: id } });
      if (codeTaken) throw conflict('Энэ мерчант код бүртгэлтэй байна');
      merchant.code = data.code.toLowerCase();
    }

    if (data.username && data.username.toLowerCase() !== merchant.username) {
      const userTaken = await PartnerMerchant.findOne({ username: data.username.toLowerCase(), _id: { $ne: id } });
      if (userTaken) throw conflict('Энэ нэвтрэх нэр бүртгэлтэй байна');
      merchant.username = data.username.toLowerCase();
    }

    if (data.name !== undefined) merchant.name = data.name.trim();
    if (data.clientId !== undefined) merchant.clientId = (data.clientId as any) || undefined;
    if (data.allowedStations !== undefined) merchant.allowedStations = data.allowedStations;
    if (data.allowedScopes !== undefined) merchant.allowedScopes = data.allowedScopes;
    if (data.isActive !== undefined) merchant.isActive = data.isActive;
    if (data.ipWhitelist !== undefined) {
      merchant.ipWhitelist = data.ipWhitelist.map((ip) => ip.trim()).filter(Boolean);
    }
    if (data.contactName !== undefined) merchant.contactName = data.contactName.trim();
    if (data.contactPhone !== undefined) merchant.contactPhone = data.contactPhone.trim();
    if (data.contactEmail !== undefined) merchant.contactEmail = data.contactEmail.trim() || undefined;
    if (data.description !== undefined) merchant.description = data.description.trim();

    await merchant.save();
    res.json(merchant.toJSON());
  }),
);

// ---------------------------------------------------------------------------
// 7. Toggle Status (Instant on/off access control)
// ---------------------------------------------------------------------------

partnerMerchantsRouter.patch(
  '/:id/status',
  validate(z.object({ isActive: z.boolean() })),
  asyncHandler(async (req, res) => {
    const { isActive } = req.body as { isActive: boolean };
    const merchant = await PartnerMerchant.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive } },
      { new: true },
    );
    if (!merchant) throw notFound('Мерчант олдсонгүй');

    // If deactivated, revoke all active sessions immediately
    if (!isActive) {
      await revokeAllPartnerTokens(String(merchant._id));
    }

    res.json({ ok: true, isActive: merchant.isActive });
  }),
);

// ---------------------------------------------------------------------------
// 8. Reset Password
// ---------------------------------------------------------------------------

partnerMerchantsRouter.post(
  '/:id/reset-password',
  validate(z.object({ newPassword: z.string().min(6, 'Нууц үг хамгийн багадаа 6 тэмдэгт байна') })),
  asyncHandler(async (req, res) => {
    const { newPassword } = req.body as { newPassword: string };
    const passwordHash = await hashPartnerPassword(newPassword);

    const merchant = await PartnerMerchant.findByIdAndUpdate(
      req.params.id,
      { $set: { passwordHash }, $inc: { tokenVersion: 1 } },
      { new: true },
    );
    if (!merchant) throw notFound('Мерчант олдсонгүй');

    // Revoke old tokens on password reset
    await revokeAllPartnerTokens(String(merchant._id));

    res.json({ ok: true, message: 'Нууц үг амжилттай солигдлоо' });
  }),
);

// ---------------------------------------------------------------------------
// 9. Revoke Tokens
// ---------------------------------------------------------------------------

partnerMerchantsRouter.post(
  '/:id/revoke-tokens',
  asyncHandler(async (req, res) => {
    const merchant = await PartnerMerchant.findById(req.params.id);
    if (!merchant) throw notFound('Мерчант олдсонгүй');

    await revokeAllPartnerTokens(String(merchant._id));
    res.json({ ok: true, message: 'Бүх идэвхтэй нэвтрэлтийн токенууд цуцлагдлаа' });
  }),
);

// ---------------------------------------------------------------------------
// 10. Delete Merchant
// ---------------------------------------------------------------------------

partnerMerchantsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const merchant = await PartnerMerchant.findByIdAndDelete(req.params.id);
    if (!merchant) throw notFound('Мерчант олдсонгүй');

    await revokeAllPartnerTokens(String(merchant._id));
    res.json({ ok: true, message: 'Мерчант амжилттай устгагдлаа' });
  }),
);

// ---------------------------------------------------------------------------
// 11. Per-Merchant Logs
// ---------------------------------------------------------------------------

partnerMerchantsRouter.get(
  '/:id/logs',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 30));

    const [items, total] = await Promise.all([
      PartnerApiLog.find({ merchantId: req.params.id })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      PartnerApiLog.countDocuments({ merchantId: req.params.id }),
    ]);

    res.json({
      items: items.map((l) => ({
        id: String(l._id),
        method: l.method,
        endpoint: l.endpoint,
        statusCode: l.statusCode,
        durationMs: l.durationMs,
        ip: l.ip,
        userAgent: l.userAgent,
        requestQuery: l.requestQuery,
        requestBody: l.requestBody,
        errorMessage: l.errorMessage,
        createdAt: l.createdAt,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  }),
);

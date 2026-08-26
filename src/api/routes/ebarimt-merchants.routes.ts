import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../../lib/errors';
import { EbarimtMerchant, ensureDefaultEbarimtMerchant } from '../../models/EbarimtMerchant';
import { checkEbarimtMerchant } from '../../services/ebarimt.service';
import {
  asyncHandler,
  paginate,
  paginationSchema,
  requireAuth,
  requireOperator,
  validate,
} from '../middleware';

export const ebarimtMerchantsRouter = Router();
ebarimtMerchantsRouter.use(requireAuth);

const listQuery = paginationSchema.extend({
  search: z.string().optional(),
});

ebarimtMerchantsRouter.get(
  '/',
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    await ensureDefaultEbarimtMerchant();
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const filter: Record<string, unknown> = {};
    if (q.search) {
      filter.$or = [
        { name: { $regex: q.search, $options: 'i' } },
        { merchantTin: { $regex: q.search, $options: 'i' } },
      ];
    }

    const { skip, limit } = paginate(q);
    const [data, total] = await Promise.all([
      EbarimtMerchant.find(filter).sort({ isDefault: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      EbarimtMerchant.countDocuments(filter),
    ]);

    res.json({
      data: data.map((m) => ({ ...m, id: String(m._id) })),
      total,
      page: q.page,
      limit: q.limit,
    });
  }),
);

ebarimtMerchantsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const merchant = await EbarimtMerchant.findById(req.params.id).lean();
    if (!merchant) throw notFound('eBarimt Merchant not found');
    res.json({ ...merchant, id: String(merchant._id) });
  }),
);

const merchantSchema = z.object({
  name: z.string().min(2, 'Нэрээ оруулна уу'),
  merchantTin: z.string().min(4, 'ААН-ийн Регистрийн дугаарыг оруулна уу'),
  districtCode: z.string().default('23'),
  khorooCode: z.string().default('1'),
  envMode: z.enum(['PRODUCTION', 'TEST']).default('PRODUCTION'),
  prodApiUrl: z.string().default('http://103.143.40.43:7080/'),
  testApiUrl: z.string().default('http://103.236.194.50:7080/'),
  legacyApiUrl: z.string().default('http://103.143.40.43:5000/'),
  ebarimtApiUrl: z.string().default('http://103.143.40.43:7080/'),
  isDefault: z.boolean().default(true),
  enabled: z.boolean().default(true),
  autoSend: z.boolean().default(true),
});

ebarimtMerchantsRouter.post(
  '/',
  requireOperator,
  validate(merchantSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof merchantSchema>;

    if (body.isDefault) {
      await EbarimtMerchant.updateMany({}, { $set: { isDefault: false } });
    }

    const created = await EbarimtMerchant.create(body);
    const verified = await checkEbarimtMerchant(String(created._id)).catch(() => created);
    const obj = verified.toObject ? verified.toObject() : created.toObject();
    res.status(201).json({ ...obj, id: String(created._id) });
  }),
);

ebarimtMerchantsRouter.put(
  '/:id',
  requireOperator,
  validate(merchantSchema.partial()),
  asyncHandler(async (req, res) => {
    const body = req.body as Partial<z.infer<typeof merchantSchema>>;

    if (body.isDefault) {
      await EbarimtMerchant.updateMany({ _id: { $ne: req.params.id } }, { $set: { isDefault: false } });
    }

    const updated = await EbarimtMerchant.findByIdAndUpdate(req.params.id, { $set: body }, { new: true });
    if (!updated) throw notFound('eBarimt Merchant not found');

    const verified = await checkEbarimtMerchant(String(updated._id)).catch(() => updated);
    const obj = verified.toObject ? verified.toObject() : updated.toObject();

    res.json({ ...obj, id: String(updated._id) });
  }),
);

ebarimtMerchantsRouter.post(
  '/:id/check',
  requireOperator,
  asyncHandler(async (req, res) => {
    const verified = await checkEbarimtMerchant(req.params.id);
    res.json({ ...verified.toObject(), id: String(verified._id) });
  }),
);

ebarimtMerchantsRouter.delete(
  '/:id',
  requireOperator,
  asyncHandler(async (req, res) => {
    const deleted = await EbarimtMerchant.findByIdAndDelete(req.params.id);
    if (!deleted) throw notFound('eBarimt Merchant not found');
    res.json({ ok: true });
  }),
);


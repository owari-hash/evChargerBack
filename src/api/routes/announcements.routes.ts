import { Router } from 'express';
import { z } from 'zod';
import { badRequest, notFound } from '../../lib/errors';
import { imageUpload, uploadUrl } from '../../lib/uploads';
import { Announcement } from '../../models/Announcement';
import {
  asyncHandler,
  paginate,
  paginationSchema,
  requireAuth,
  requireOperator,
  validate,
} from '../middleware';

/**
 * Мэдээ — operator-authored announcements. A signed-in driver on the kiosk or
 * the app sees the latest active one as a one-time modal (served by the
 * driver API's own `/app-api/app/announcements`); this router is the console
 * side that writes them.
 */
export const announcementsRouter = Router();
announcementsRouter.use(requireAuth);

const listQuery = paginationSchema.extend({
  status: z.enum(['all', 'active', 'inactive']).optional(),
});

announcementsRouter.get(
  '/',
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const filter: Record<string, unknown> = {};
    if (q.status === 'active') filter.isActive = true;
    else if (q.status === 'inactive') filter.isActive = false;

    const { skip, limit } = paginate(q);
    const [data, total] = await Promise.all([
      Announcement.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Announcement.countDocuments(filter),
    ]);
    res.json({
      data: data.map((a) => ({ ...a, id: String(a._id) })),
      total,
      page: q.page,
      limit: q.limit,
    });
  }),
);

const createSchema = z.object({
  title: z.string().trim().min(1, 'Гарчиг оруулна уу').max(200),
  body: z.string().trim().min(1, 'Агуулга оруулна уу').max(4000),
  isActive: z.coerce.boolean().default(true),
});

announcementsRouter.post(
  '/',
  requireOperator,
  imageUpload('announcements'),
  asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Буруу өгөгдөл');
    }
    const file = req.file;
    const announcement = await Announcement.create({
      ...parsed.data,
      imageUrl: file ? uploadUrl('announcements', file.filename) : undefined,
      createdBy: req.user?.email,
    });
    res.status(201).json(announcement.toJSON());
  }),
);

const updateSchema = createSchema.partial().extend({
  removeImage: z.coerce.boolean().optional(),
});

announcementsRouter.patch(
  '/:id',
  requireOperator,
  imageUpload('announcements'),
  asyncHandler(async (req, res) => {
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Буруу өгөгдөл');
    }
    const { removeImage, ...rest } = parsed.data;
    const file = req.file;

    const update: Record<string, unknown> = { ...rest };
    if (file) update.imageUrl = uploadUrl('announcements', file.filename);
    else if (removeImage) update.imageUrl = undefined;

    const updated = await Announcement.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!updated) throw notFound('Мэдээ олдсонгүй');
    res.json(updated.toJSON());
  }),
);

announcementsRouter.delete(
  '/:id',
  requireOperator,
  asyncHandler(async (req, res) => {
    const deleted = await Announcement.findByIdAndDelete(req.params.id);
    if (!deleted) throw notFound('Мэдээ олдсонгүй');
    res.status(204).end();
  }),
);

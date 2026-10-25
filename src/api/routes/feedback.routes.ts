import { Router } from 'express';
import { z } from 'zod';
<<<<<<< HEAD
import { Feedback } from '../../models/Feedback';
import { asyncHandler, requireAuth, requireOperator, validate } from '../middleware';

export const feedbackAdminRouter = Router();

feedbackAdminRouter.use(requireAuth, requireOperator);

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  status: z.enum(['NEW', 'READ', 'RESOLVED']).optional(),
  search: z.string().trim().optional(),
});

/**
 * GET /api/feedback
 * List feedback submissions.
 */
feedbackAdminRouter.get(
  '/',
  validate(listQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuerySchema>;
    const filter: Record<string, unknown> = {};

    if (q.status) {
      filter.status = q.status;
    }
    if (q.search) {
      filter.$or = [
        { message: { $regex: q.search, $options: 'i' } },
        { phone: { $regex: q.search, $options: 'i' } },
      ];
    }

    const total = await Feedback.countDocuments(filter);
    const rows = await Feedback.find(filter)
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean();

    res.json({
      items: rows.map((r) => ({
        id: String(r._id),
        phone: r.phone ?? null,
        message: r.message,
        source: r.source ?? 'web',
        status: r.status,
        smsDeliveredTo: r.smsDeliveredTo ?? [],
        createdAt: r.createdAt,
      })),
      total,
      page: q.page,
      limit: q.limit,
      totalPages: Math.ceil(total / q.limit),
=======
import { notFound } from '../../lib/errors';
import { Feedback } from '../../models/Feedback';
import {
  asyncHandler,
  paginate,
  paginationSchema,
  requireAuth,
  requireOperator,
  validate,
} from '../middleware';

/**
 * Санал хүсэлт — what drivers sent from the kiosk footer or the app
 * (`POST /app-api/feedback`). Operators list them here and mark them done.
 */
export const feedbackRouter = Router();
feedbackRouter.use(requireAuth);

const listQuery = paginationSchema.extend({
  status: z.enum(['all', 'new', 'done']).optional(),
});

feedbackRouter.get(
  '/',
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const filter: Record<string, unknown> = {};
    if (q.status === 'new' || q.status === 'done') filter.status = q.status;
    const { skip, limit } = paginate(q);
    const [data, total, unread] = await Promise.all([
      Feedback.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Feedback.countDocuments(filter),
      Feedback.countDocuments({ status: 'new' }),
    ]);
    res.json({
      data: data.map((f) => ({ ...f, id: String(f._id) })),
      total,
      unread,
      page: q.page,
      limit: q.limit,
>>>>>>> 930a66477af5d205b73aa492f2dda061218dc4c3
    });
  }),
);

<<<<<<< HEAD
const updateSchema = z.object({
  status: z.enum(['NEW', 'READ', 'RESOLVED']),
});

/**
 * PATCH /api/feedback/:id
 * Update status of feedback.
 */
feedbackAdminRouter.patch(
  '/:id',
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const { status } = req.body as z.infer<typeof updateSchema>;
    const updated = await Feedback.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      { new: true },
    ).lean();

    if (!updated) {
      res.status(404).json({ error: 'Санал хүсэлт олдсонгүй' });
      return;
    }

    res.json({
      id: String(updated._id),
      status: updated.status,
      phone: updated.phone ?? null,
      message: updated.message,
      createdAt: updated.createdAt,
    });
=======
const patchSchema = z.object({ status: z.enum(['new', 'done']) });

feedbackRouter.patch(
  '/:id',
  requireOperator,
  validate(patchSchema),
  asyncHandler(async (req, res) => {
    const { status } = req.body as z.infer<typeof patchSchema>;
    const updated = await Feedback.findByIdAndUpdate(
      req.params.id,
      { $set: { status, handledBy: status === 'done' ? req.user?.email : undefined } },
      { new: true },
    ).lean();
    if (!updated) throw notFound('Санал хүсэлт олдсонгүй');
    res.json({ ...updated, id: String(updated._id) });
  }),
);

feedbackRouter.delete(
  '/:id',
  requireOperator,
  asyncHandler(async (req, res) => {
    const deleted = await Feedback.findByIdAndDelete(req.params.id).lean();
    if (!deleted) throw notFound('Санал хүсэлт олдсонгүй');
    res.json({ ok: true });
>>>>>>> 930a66477af5d205b73aa492f2dda061218dc4c3
  }),
);

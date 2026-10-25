import { Router } from 'express';
import { z } from 'zod';
import { Feedback } from '../../models/Feedback';
import { asyncHandler, requireAuth, requireOperator, validate } from '../middleware';

export const feedbackAdminRouter = Router();
export const feedbackRouter = feedbackAdminRouter;

feedbackAdminRouter.use(requireAuth, requireOperator);

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  status: z.string().optional(),
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

    if (q.status && q.status !== 'all') {
      if (q.status === 'new' || q.status === 'NEW') {
        filter.status = { $in: ['new', 'NEW'] };
      } else if (q.status === 'done' || q.status === 'RESOLVED') {
        filter.status = { $in: ['done', 'RESOLVED'] };
      } else {
        filter.status = q.status;
      }
    }

    if (q.search) {
      filter.$or = [
        { message: { $regex: q.search, $options: 'i' } },
        { phone: { $regex: q.search, $options: 'i' } },
        { userName: { $regex: q.search, $options: 'i' } },
      ];
    }

    const [rows, total, unread] = await Promise.all([
      Feedback.find(filter)
        .sort({ createdAt: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit)
        .lean(),
      Feedback.countDocuments(filter),
      Feedback.countDocuments({ status: { $in: ['new', 'NEW'] } }),
    ]);

    const formatted = rows.map((r) => ({
      id: String(r._id),
      message: r.message,
      phone: r.phone ?? null,
      userId: r.userId ?? null,
      userName: r.userName ?? null,
      source: r.source ?? 'web',
      status: r.status === 'done' || r.status === 'RESOLVED' ? 'done' : 'new',
      handledBy: r.handledBy ?? null,
      smsDeliveredTo: r.smsDeliveredTo ?? [],
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));

    res.json({
      data: formatted,
      items: formatted,
      total,
      unread,
      page: q.page,
      limit: q.limit,
      totalPages: Math.ceil(total / q.limit),
    });
  }),
);

const patchSchema = z.object({
  status: z.enum(['new', 'done', 'NEW', 'RESOLVED']),
});

/**
 * PATCH /api/feedback/:id
 * Mark feedback as new or done.
 */
feedbackAdminRouter.patch(
  '/:id',
  validate(patchSchema),
  asyncHandler(async (req, res) => {
    const { status } = req.body as z.infer<typeof patchSchema>;
    const normalized = status.toLowerCase() === 'done' ? 'done' : 'new';
    const updated = await Feedback.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          status: normalized,
          handledBy: normalized === 'done' ? (req.user?.email ?? 'operator') : undefined,
        },
      },
      { new: true },
    ).lean();

    if (!updated) {
      res.status(404).json({ error: 'Санал хүсэлт олдсонгүй' });
      return;
    }

    res.json({
      id: String(updated._id),
      message: updated.message,
      status: updated.status,
      phone: updated.phone ?? null,
      handledBy: updated.handledBy ?? null,
      createdAt: updated.createdAt,
    });
  }),
);

/**
 * DELETE /api/feedback/:id
 * Permanently delete a feedback entry.
 */
feedbackAdminRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const deleted = await Feedback.findByIdAndDelete(req.params.id).lean();
    if (!deleted) {
      res.status(404).json({ error: 'Санал хүсэлт олдсонгүй' });
      return;
    }
    res.json({ ok: true, id: req.params.id });
  }),
);

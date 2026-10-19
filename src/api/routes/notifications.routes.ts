import { Router } from 'express';
import { z } from 'zod';
import { AdminNotification } from '../../models/AdminNotification';
import { broadcastNotification } from '../../realtime/notification-socket';
import { asyncHandler, requireAuth, validate } from '../middleware';

export const adminNotificationsRouter = Router();
adminNotificationsRouter.use(requireAuth);

adminNotificationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.user?.id ?? 'system';
    const [rows, unread] = await Promise.all([
      AdminNotification.find({ userId }).sort({ at: -1 }).limit(50).lean(),
      AdminNotification.countDocuments({ userId, isRead: false }),
    ]);

    const items = rows.map((doc) => ({
      key: doc.key,
      kind: doc.kind,
      title: doc.title,
      detail: doc.detail,
      tone: doc.tone,
      at: doc.at ? new Date(doc.at).toISOString() : new Date().toISOString(),
      href: doc.href,
      toasted: true,
      isRead: doc.isRead,
    }));

    res.json({
      items,
      unread,
    });
  }),
);

const recordSchema = z.object({
  key: z.string().trim().min(1),
  kind: z.string().trim().min(1),
  title: z.string().trim().min(1),
  detail: z.string().trim().min(1),
  tone: z.string().optional().default('info'),
  href: z.string().optional(),
  at: z.string().optional(),
});

adminNotificationsRouter.post(
  '/',
  validate(recordSchema, 'body'),
  asyncHandler(async (req, res) => {
    const userId = req.user?.id ?? 'system';
    const body = req.body as z.infer<typeof recordSchema>;

    const doc = await AdminNotification.findOneAndUpdate(
      { userId, key: body.key },
      {
        $setOnInsert: {
          userId,
          key: body.key,
          kind: body.kind,
          title: body.title,
          detail: body.detail,
          tone: body.tone,
          href: body.href,
          at: body.at ? new Date(body.at) : new Date(),
          isRead: false,
        },
      },
      { upsert: true, new: true },
    );

    const notificationData = {
      key: doc.key,
      kind: doc.kind,
      title: doc.title,
      detail: doc.detail,
      tone: doc.tone,
      at: doc.at ? new Date(doc.at).toISOString() : new Date().toISOString(),
      href: doc.href,
      toasted: true,
      isRead: doc.isRead,
    };

    broadcastNotification({ userId, role: 'admin' }, notificationData);

    res.status(201).json({
      ok: true,
      notification: notificationData,
    });
  }),
);

adminNotificationsRouter.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    const userId = req.user?.id ?? 'system';
    await AdminNotification.updateMany({ userId, isRead: false }, { $set: { isRead: true } });
    res.json({ ok: true, readAt: new Date().toISOString() });
  }),
);

adminNotificationsRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.user?.id ?? 'system';
    const key = req.query.key as string | undefined;
    if (key) {
      await AdminNotification.deleteOne({ userId, key });
    } else {
      await AdminNotification.deleteMany({ userId });
    }
    res.json({ ok: true });
  }),
);

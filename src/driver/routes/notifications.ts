import { Router } from 'express';
import { z } from 'zod';
import { DriverNotification } from '../../models/DriverNotification';
import { requireUser } from '../auth/session';
import { parseBody, route } from '../http';

export const driverNotificationsRoutes = Router();

const createSchema = z.object({
  kind: z.enum(['wallet', 'announcement', 'session-started', 'session-finished']),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(2000),
  imageUrl: z.string().nullable().optional(),
  href: z.string().optional(),
  dedupeKey: z.string().optional(),
  at: z.string().optional(),
});

const readSchema = z.object({
  id: z.string().optional(),
  all: z.boolean().optional(),
});

driverNotificationsRoutes.get(
  '/',
  route(async (req) => {
    const user = await requireUser(req);
    const [rows, unread] = await Promise.all([
      DriverNotification.find({ userId: user.id }).sort({ at: -1 }).limit(50).lean(),
      DriverNotification.countDocuments({ userId: user.id, isRead: false }),
    ]);

    const items = rows.map((doc) => ({
      id: String(doc._id),
      kind: doc.kind,
      title: doc.title,
      body: doc.body,
      imageUrl: doc.imageUrl ?? null,
      href: doc.href,
      dedupeKey: doc.dedupeKey,
      at: doc.at ? new Date(doc.at).toISOString() : new Date().toISOString(),
      isRead: doc.isRead,
    }));

    return {
      items,
      unread,
    };
  }),
);

driverNotificationsRoutes.post(
  '/',
  route(async (req) => {
    const user = await requireUser(req);
    const body = parseBody(req, createSchema);

    let doc;
    if (body.dedupeKey) {
      doc = await DriverNotification.findOneAndUpdate(
        { userId: user.id, dedupeKey: body.dedupeKey },
        {
          $setOnInsert: {
            userId: user.id,
            kind: body.kind,
            title: body.title,
            body: body.body,
            imageUrl: body.imageUrl,
            href: body.href,
            dedupeKey: body.dedupeKey,
            at: body.at ? new Date(body.at) : new Date(),
            isRead: false,
          },
        },
        { upsert: true, new: true },
      );
    } else {
      doc = await DriverNotification.create({
        userId: user.id,
        kind: body.kind,
        title: body.title,
        body: body.body,
        imageUrl: body.imageUrl,
        href: body.href,
        at: body.at ? new Date(body.at) : new Date(),
        isRead: false,
      });
    }

    return {
      ok: true,
      item: {
        id: String(doc._id),
        kind: doc.kind,
        title: doc.title,
        body: doc.body,
        imageUrl: doc.imageUrl ?? null,
        href: doc.href,
        dedupeKey: doc.dedupeKey,
        at: doc.at ? new Date(doc.at).toISOString() : new Date().toISOString(),
        isRead: doc.isRead,
      },
    };
  }),
);

driverNotificationsRoutes.post(
  '/read',
  route(async (req) => {
    const user = await requireUser(req);
    const body = parseBody(req, readSchema);

    if (body.id) {
      await DriverNotification.updateOne({ _id: body.id, userId: user.id }, { $set: { isRead: true } });
    } else {
      await DriverNotification.updateMany({ userId: user.id, isRead: false }, { $set: { isRead: true } });
    }

    return { ok: true };
  }),
);

driverNotificationsRoutes.delete(
  '/:id',
  route(async (req) => {
    const user = await requireUser(req);
    await DriverNotification.deleteOne({ _id: req.params.id, userId: user.id });
    return { ok: true };
  }),
);

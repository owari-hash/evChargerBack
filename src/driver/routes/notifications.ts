import { Router } from 'express';
import { z } from 'zod';
import { Announcement } from '../../models/Announcement';
import { DriverNotification } from '../../models/DriverNotification';
import { broadcastNotification } from '../../realtime/notification-socket';
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

/**
 * The time an announcement entry should show: when the operator published
 * the Мэдээ, not when this driver's device happened to notice it. Clients
 * used to file it with "now", so a three-day-old Мэдээ read as «Өнөөдөр»;
 * correcting it here also fixes the rows already stored that way.
 *
 * Matched by `announcement:<id>` when the client sent one, otherwise (older
 * rows) by title: the newest announcement with that title published no later
 * than the row itself.
 */
async function announcementTimes(
  rows: { kind?: string; title?: string; dedupeKey?: string | null; at?: Date | null }[],
): Promise<Map<(typeof rows)[number], Date>> {
  const out = new Map<(typeof rows)[number], Date>();
  const wanted = rows.filter((r) => r.kind === 'announcement');
  if (wanted.length === 0) return out;

  const ids = wanted
    .map((r) => /^announcement:([a-f\d]{24})$/i.exec(r.dedupeKey ?? '')?.[1])
    .filter((id): id is string => Boolean(id));
  const titles = [...new Set(wanted.map((r) => r.title).filter((t): t is string => Boolean(t)))];
  const found = await Announcement.find({
    $or: [{ _id: { $in: ids } }, { title: { $in: titles } }],
  })
    .select('title createdAt')
    .sort({ createdAt: -1 })
    .lean<{ _id: unknown; title: string; createdAt: Date }[]>();

  for (const row of wanted) {
    const byId = /^announcement:([a-f\d]{24})$/i.exec(row.dedupeKey ?? '')?.[1];
    const match = byId
      ? found.find((a) => String(a._id) === byId)
      : found.find(
          (a) =>
            a.title === row.title &&
            (!row.at || new Date(a.createdAt).getTime() <= new Date(row.at).getTime() + 60_000),
        );
    if (match) out.set(row, new Date(match.createdAt));
  }
  return out;
}

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

    const published = await announcementTimes(rows);
    const items = rows
      .map((doc) => ({
        id: String(doc._id),
        kind: doc.kind,
        title: doc.title,
        body: doc.body,
        imageUrl: doc.imageUrl ?? null,
        href: doc.href,
        dedupeKey: doc.dedupeKey,
        at: (published.get(doc) ?? (doc.at ? new Date(doc.at) : new Date())).toISOString(),
        isRead: doc.isRead,
      }))
      .sort((a, b) => b.at.localeCompare(a.at));

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
    if (body.kind === 'announcement') {
      const [published] = (await announcementTimes([{ ...body, at: new Date() }])).values();
      if (published) body.at = published.toISOString();
    }

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

    const itemData = {
      id: String(doc._id),
      kind: doc.kind,
      title: doc.title,
      body: doc.body,
      imageUrl: doc.imageUrl ?? null,
      href: doc.href,
      dedupeKey: doc.dedupeKey,
      at: doc.at ? new Date(doc.at).toISOString() : new Date().toISOString(),
      isRead: doc.isRead,
    };

    broadcastNotification({ userId: user.id, role: 'driver' }, itemData);

    return {
      ok: true,
      item: itemData,
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

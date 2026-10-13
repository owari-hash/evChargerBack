import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../../lib/errors';
import { decideUpdate } from '../../lib/appVersion';
import { AppRelease, APP_PLATFORMS } from '../../models/AppRelease';
import { asyncHandler, requireAuth, requireOperator, validate } from '../middleware';

export const appReleasesRouter = Router();
appReleasesRouter.use(requireAuth);

/**
 * Mobile app release settings — one row per store, addressed by platform rather
 * than by id, because there are exactly two and the console edits them in place.
 */

const releaseSchema = z
  .object({
    latestVersion: z
      .string()
      .trim()
      .min(1, 'Хувилбарыг оруулна уу')
      .max(32)
      .regex(/^\d+(\.\d+)*$/, 'Хувилбар 1.2.3 хэлбэртэй байна'),
    latestBuild: z.number().int().min(0).optional().nullable(),
    minSupportedVersion: z
      .string()
      .trim()
      .max(32)
      .regex(/^\d+(\.\d+)*$/, 'Хувилбар 1.2.3 хэлбэртэй байна')
      .optional()
      .nullable()
      .or(z.literal('')),
    minSupportedBuild: z.number().int().min(0).optional().nullable(),
    storeUrl: z.string().trim().url('Дэлгүүрийн холбоос буруу байна').max(500),
    releaseNotesMn: z.string().trim().max(2000).optional().nullable(),
    releaseNotesEn: z.string().trim().max(2000).optional().nullable(),
    isActive: z.boolean().default(true),
  })
  .refine(
    (v) =>
      v.latestBuild === undefined ||
      v.latestBuild === null ||
      v.minSupportedBuild === undefined ||
      v.minSupportedBuild === null ||
      v.minSupportedBuild <= v.latestBuild,
    {
      message: 'Заавал шинэчлэх билд нь сүүлийн билдээс их байж болохгүй',
      path: ['minSupportedBuild'],
    },
  );

const platformParam = z.enum(APP_PLATFORMS);

appReleasesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const rows = await AppRelease.find().lean();
    // Both platforms are always returned, so the console renders two cards
    // whether or not either has been configured yet.
    const data = APP_PLATFORMS.map((platform) => {
      const row = rows.find((r) => r.platform === platform);
      return row ? { ...row, id: String(row._id) } : { platform, configured: false };
    });
    res.json({ data });
  }),
);

appReleasesRouter.put(
  '/:platform',
  requireOperator,
  validate(releaseSchema),
  asyncHandler(async (req, res) => {
    const parsed = platformParam.safeParse(req.params.platform);
    if (!parsed.success) throw badRequest('Платформ буруу байна');

    const body = req.body as z.infer<typeof releaseSchema>;

    const updated = await AppRelease.findOneAndUpdate(
      { platform: parsed.data },
      {
        $set: {
          latestVersion: body.latestVersion,
          latestBuild: body.latestBuild ?? undefined,
          minSupportedVersion: body.minSupportedVersion || undefined,
          minSupportedBuild: body.minSupportedBuild ?? undefined,
          storeUrl: body.storeUrl,
          releaseNotesMn: body.releaseNotesMn ?? undefined,
          releaseNotesEn: body.releaseNotesEn ?? undefined,
          isActive: body.isActive,
          updatedBy: req.user?.email,
        },
        $setOnInsert: { platform: parsed.data },
      },
      { new: true, upsert: true },
    ).lean();

    res.json({ ...updated, id: String(updated!._id) });
  }),
);

const previewQuery = z.object({
  version: z.string().trim().min(1).max(32),
  build: z.coerce.number().int().min(0).optional(),
});

/**
 * What a driver on a given build would be shown. Lets an operator confirm a
 * force threshold before saving it, rather than finding out from support calls.
 */
appReleasesRouter.get(
  '/:platform/preview',
  validate(previewQuery, 'query'),
  asyncHandler(async (req, res) => {
    const parsed = platformParam.safeParse(req.params.platform);
    if (!parsed.success) throw badRequest('Платформ буруу байна');

    const q = req.query as unknown as z.infer<typeof previewQuery>;
    const release = await AppRelease.findOne({ platform: parsed.data }).lean();
    if (!release) {
      res.json({ updateAvailable: false, forceUpdate: false, configured: false });
      return;
    }

    res.json({
      configured: true,
      ...decideUpdate(release, { version: q.version, build: q.build }),
    });
  }),
);

appReleasesRouter.delete(
  '/:platform',
  requireOperator,
  asyncHandler(async (req, res) => {
    const parsed = platformParam.safeParse(req.params.platform);
    if (!parsed.success) throw badRequest('Платформ буруу байна');

    await AppRelease.deleteOne({ platform: parsed.data });
    res.status(204).end();
  }),
);

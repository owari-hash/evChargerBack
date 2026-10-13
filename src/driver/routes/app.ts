import { Router } from 'express';
import { z } from 'zod';
import { decideUpdate } from '../../lib/appVersion';
import { AppRelease, APP_PLATFORMS } from '../../models/AppRelease';
import { guard, HOUR, parseQuery, route } from '../http';

export const appRoutes = Router();

const checkQuery = z.object({
  platform: z.enum(APP_PLATFORMS),
  /** The running marketing version, e.g. "1.0.13". */
  version: z.string().trim().min(1).max(32),
  /** versionCode / CFBundleVersion. Absent on builds that predate this check. */
  build: z.coerce.number().int().min(0).optional(),
});

/**
 * GET /app-api/app/version?platform=android&version=1.0.13&build=68
 *
 * Unauthenticated on purpose: the app asks this before the driver has signed in,
 * and a forced update has to be able to stop a build that can no longer talk to
 * the API at all.
 *
 * Always 200 with a decision. If no release row exists for the platform yet, the
 * honest answer is "nothing to update" — never a prompt built from defaults.
 */
appRoutes.get(
  '/version',
  route(async (req) => {
    // Generous: the app checks once per launch, but a driver reopening the app
    // repeatedly on a bad connection should not get blocked out of it.
    guard(req, 'app-version', 60, HOUR);

    const q = parseQuery(req, checkQuery);
    const release = await AppRelease.findOne({ platform: q.platform }).lean();

    if (!release) {
      return {
        platform: q.platform,
        currentVersion: q.version,
        currentBuild: q.build ?? null,
        updateAvailable: false,
        forceUpdate: false,
        latestVersion: q.version,
        latestBuild: q.build ?? null,
        storeUrl: null,
        releaseNotes: '',
      };
    }

    const decision = decideUpdate(release, { version: q.version, build: q.build });

    return {
      platform: q.platform,
      currentVersion: q.version,
      currentBuild: q.build ?? null,
      updateAvailable: decision.updateAvailable,
      forceUpdate: decision.forceUpdate,
      latestVersion: release.latestVersion,
      latestBuild: release.latestBuild ?? null,
      storeUrl: release.storeUrl,
      releaseNotes: release.releaseNotesMn ?? '',
      releaseNotesEn: release.releaseNotesEn ?? '',
    };
  }),
);

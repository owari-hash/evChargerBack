import { Router } from 'express';
import { z } from 'zod';
import { decideUpdate } from '../../lib/appVersion';
import { normalizeConnectorCode } from '../../lib/connectorCode';
import { Announcement } from '../../models/Announcement';
import { AppRelease, APP_PLATFORMS } from '../../models/AppRelease';
import { ChargePoint } from '../../models/ChargePoint';
import { Connector } from '../../models/Connector';
import { getCurrentUser, requireUser } from '../auth/session';
import { DriverUser } from '../store';
import { guard, HOUR, notFound, parseQuery, route } from '../http';
import { feedbackRoutes } from './feedback';

export const appRoutes = Router();
appRoutes.use('/feedback', feedbackRoutes);

/**
 * GET /app-api/app/announcements
 *
 * The last few active Мэдээ, newest first — the kiosk and the app show the
 * newest one a signed-in driver has not dismissed yet as a modal, then keep
 * the rest around so the notification bell has something to list. Public
 * like the other driver-shell endpoints; the client decides whether to
 * actually show anything based on its own sign-in state.
 */
appRoutes.get(
  '/announcements',
  route(async (req) => {
    // The app re-checks on every resume and every few minutes in the
    // foreground, and drivers on one carrier share an address behind NAT, so
    // 60 an hour per IP starved them. It is a small read of ten rows at most.
    guard(req, 'announcements', 600, HOUR);
    const rows = await Announcement.find({ isActive: true })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    // Signed in: say which ones this driver already dismissed anywhere.
    const user = await getCurrentUser(req).catch(() => null);
    let seen: Set<string> | undefined;
    if (user) {
      const doc = await DriverUser.findById(user.id)
        .select('seenAnnouncements')
        .lean<{ seenAnnouncements?: string[] }>();
      seen = new Set(doc?.seenAnnouncements ?? []);
    }

    return {
      announcements: rows.map((a) => ({
        id: String(a._id),
        title: a.title,
        body: a.body,
        imageUrl: a.imageUrl ?? null,
        createdAt: a.createdAt,
        ...(seen ? { seen: seen.has(String(a._id)) } : {}),
      })),
    };
  }),
);

/**
 * POST /app-api/app/announcements/:id/seen
 *
 * The driver has been shown this Мэдээ. Kept on the account, not the device,
 * so it is not shown again after signing in again or on another phone.
 */
appRoutes.post(
  '/announcements/:id/seen',
  route(async (req) => {
    const user = await requireUser(req);
    const id = String(req.params.id ?? '');
    if (!/^[a-f\d]{24}$/i.test(id)) throw notFound('Мэдээ олдсонгүй');
    // One id per Мэдээ ever published, so this stays small.
    await DriverUser.updateOne({ _id: user.id }, { $addToSet: { seenAnnouncements: id } });
    return { ok: true };
  }),
);

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

const codeParam = z.object({ code: z.string().trim().min(1).max(16) });

/**
 * GET /app-api/app/connector/:code
 *
 * Resolves the short code printed on a connector's QR sticker to the station
 * and gun it belongs to. Unauthenticated: a driver scans this before signing
 * in, and the page it lands on is what invites them to.
 */
appRoutes.get(
  '/connector/:code',
  route(async (req) => {
    guard(req, 'connector-code', 120, HOUR);

    const parsed = codeParam.safeParse(req.params);
    const code = parsed.success ? normalizeConnectorCode(parsed.data.code) : null;
    if (!code) throw notFound('Энэ код олдсонгүй');

    const connector = await Connector.findOne({ code }).lean();
    if (!connector) throw notFound('Энэ код олдсонгүй');

    const cp = await ChargePoint.findById(connector.chargePointId).lean();
    if (!cp) throw notFound('Энэ код олдсонгүй');

    return {
      code,
      stationId: String(cp._id),
      cpId: cp.cpId,
      stationName: cp.name?.trim() || cp.cpId,
      address: cp.address ?? null,
      connectorId: connector.connectorId,
      connectorType: connector.connectorType ?? null,
      powerKw: connector.powerKw ?? null,
      label: connector.label ?? null,
    };
  }),
);

/**
 * GET /app-api/app/contact
 *
 * Contact and social information for website and kiosk footer.
 */
appRoutes.get(
  '/contact',
  route(async () => {
    const { getOrCreateContactInfo } = await import('../../models/ContactInfo');
    const info = await getOrCreateContactInfo();
    return info.toJSON();
  }),
);


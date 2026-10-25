import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { getCurrentUser, requireUser } from '../auth/session';
import { ensureChargeTag } from '../charge-tag';
import {
  connectorsInUseByOthers,
  decorateSessions,
  getStation,
  holdConnector,
  releaseConnectorHold,
  getTransaction,
  listSessionsForIdTag,
  listStations,
  remoteStart,
  remoteStop,
  unlockSessionConnector,
  requestEBarimt,
} from '../charging';
import {
  badRequest,
  DriverError,
  fieldErrors,
  forbidden,
  guard,
  HOUR,
  MINUTE,
  notFound,
  parseBody,
  parseQuery,
  route,
} from '../http';
import type { StoredUser } from '../store';
import type { ChargingSession } from '../types';
import { stationQuerySchema } from '../validation';
import {
  checkTopUp,
  createTopUp,
  getTopUp,
  getSavedCards,
  getTopUpQr,
  getWallet,
  listWalletEntries,
  removeSavedCard,
  walletConfig,
} from '../wallet';

/** Recorded on the OCPP command log, so an operator can see who sent it. */
const issuer = (user: StoredUser) => `driver:${user.phone ?? user.id}`;

// ---------------------------------------------------------------------------
// Stations — public; a signed-in driver additionally sees their own session.
// ---------------------------------------------------------------------------

export const stationRoutes = Router();

const STATION_NOT_FOUND = 'Тухайн цэнэглэх станцыг олсонгүй';

stationRoutes.get(
  '/',
  route(async (req) => listStations(parseQuery(req, stationQuerySchema))),
);

stationRoutes.get(
  '/:id',
  route(async (req) => {
    const station = await getStation(req.params.id!);
    if (!station) throw notFound(STATION_NOT_FOUND);
    // Lets a client decide whether to offer "start charging" before trying it.
    return { station, demo: false, remoteStartEnabled: env.ENABLE_REMOTE_START };
  }),
);

/**
 * Everything the charging panel needs in one request — live connector states and
 * this driver's own session on this station. Polled every few seconds.
 */
stationRoutes.get(
  '/:id/live',
  route(async (req) => {
    const station = await getStation(req.params.id!);
    if (!station) throw notFound(STATION_NOT_FOUND);

    // Signed out, the connector states are still worth showing.
    const user = await getCurrentUser(req);

    let session: ChargingSession | null = null;
    if (user?.idTag) {
      const mine = await listSessionsForIdTag(user.idTag, 10);
      const here = (s: ChargingSession) =>
        s.chargePointId === station.id || s.chargePointId === station.cpId;
      // Return active session, or recent completed session (< 15 min) so driver sees completion summary and e-Barimt
      const RECENT_STOP_WINDOW_MS = 15 * 60 * 1000;
      const isRecent = (s: ChargingSession) =>
        s.status === 'Active' ||
        Boolean(
          s.stopTimestamp &&
            Date.now() - new Date(s.stopTimestamp).getTime() < RECENT_STOP_WINDOW_MS,
        );

      session =
        mine.find((s) => s.status === 'Active' && here(s)) ??
        mine.find((s) => here(s) && isRecent(s)) ??
        null;
    }

    const taken = await connectorsInUseByOthers(station.id, user?.idTag ?? undefined);

    return {
      availability: station.availability,
      connectors: station.connectors.map((c) => ({
        ...c,
        inUseByOther: taken.has(c.connectorId),
      })),
      availableConnectors: station.availableConnectors,
      totalConnectors: station.totalConnectors,
      tariffPerKwh: station.tariffPerKwh,
      session,
    };
  }),
);

const holdSchema = z.object({
  connectorId: z.coerce.number().int().min(1).max(64),
});

/**
 * "I scanned this gun and I'm at it." Called by the kiosk and app every few
 * seconds while the scanned gun is open and not yet started, so a second
 * driver scanning the same sticker sees it as in use. `{ held: false }` means
 * someone else already has it.
 */
stationRoutes.post(
  '/:id/hold',
  route(async (req) => {
    const user = await requireUser(req);
    const parsed = holdSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new DriverError(400, 'Тэмдэглэсэн талбаруудаа шалгана уу', fieldErrors(parsed.error));
    }
    const idTag = user.idTag ?? (await ensureChargeTag(user));
    if (!idTag) return { held: false };
    return { held: await holdConnector(req.params.id!, parsed.data.connectorId, idTag) };
  }),
);

/** Lets go of this driver's scan hold, e.g. they went back to scan another gun. */
stationRoutes.post(
  '/:id/release',
  route(async (req) => {
    const user = await requireUser(req);
    const parsed = holdSchema.safeParse(req.body ?? {});
    if (!parsed.success || !user.idTag) return { released: false };
    await releaseConnectorHold(req.params.id!, parsed.data.connectorId, user.idTag);
    return { released: true };
  }),
);

const startSchema = z.object({
  connectorId: z.coerce.number().int().min(1).max(64).optional(),
});

stationRoutes.post(
  '/:id/start',
  route(async (req) => {
    const user = await requireUser(req);

    if (!env.ENABLE_REMOTE_START) {
      throw forbidden(
        'Энэ сүлжээнд алсаас эхлүүлэх боломж идэвхгүй байна. Цэнэглэлтийг станц дээр нь эхлүүлнэ үү.',
      );
    }

    guard(req, `station-start:${user.id}`, 10, HOUR);

    // Without a connector the station picks a free plug itself.
    const parsed = startSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new DriverError(400, 'Тэмдэглэсэн талбаруудаа шалгана уу', fieldErrors(parsed.error));
    }

    const idTag = user.idTag ?? (await ensureChargeTag(user));
    if (!idTag) {
      throw badRequest('Цэнэглэх эрх олгож чадсангүй. Түр хүлээгээд дахин оролдоно уу.');
    }

    return remoteStart(req.params.id!, idTag, parsed.data.connectorId, issuer(user));
  }),
);

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const sessionRoutes = Router();

const sessionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

sessionRoutes.get(
  '/',
  route(async (req) => {
    const user = await requireUser(req);
    const { limit } = parseQuery(req, sessionsQuery);
    return { sessions: await decorateSessions(await listSessionsForIdTag(user.idTag, limit)) };
  }),
);

function transactionIdOf(raw: string | undefined, message: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw badRequest(message);
  return id;
}

sessionRoutes.post(
  '/:id/stop',
  route(async (req) => {
    const user = await requireUser(req);
    const transactionId = transactionIdOf(req.params.id, 'Цэнэглэлтийн энэ дугаар буруу байна');

    const session = await getTransaction(transactionId);
    if (!session) throw notFound('Тухайн цэнэглэлтийг олсонгүй');

    // Only the account whose tag started the charge may stop it.
    if (!user.idTag || user.idTag !== session.idTag) {
      throw forbidden('Энэ цэнэглэлт өөр бүртгэлд хамаарна');
    }

    const { status } = await remoteStop(transactionId, issuer(user));
    return { status };
  }),
);

/**
 * Frees the cable after a session has ended. Without it a driver on hardware
 * that latches the gun is left physically attached to the charger.
 */
sessionRoutes.post(
  '/:id/unlock',
  route(async (req) => {
    const user = await requireUser(req);
    const transactionId = transactionIdOf(req.params.id, 'Цэнэглэлтийн энэ дугаар буруу байна');

    const session = await getTransaction(transactionId);
    if (!session) throw notFound('Тухайн цэнэглэлтийг олсонгүй');

    // Only the account whose tag charged there may release that gun.
    if (!user.idTag || user.idTag !== session.idTag) {
      throw forbidden('Энэ цэнэглэлт өөр бүртгэлд хамаарна');
    }

    const { status } = await unlockSessionConnector(transactionId, issuer(user));
    return { status };
  }),
);

const ebarimtSchema = z.object({
  type: z.enum(['B2C_RECEIPT', 'B2B_RECEIPT']).default('B2C_RECEIPT'),
  customerTin: z.string().optional(),
  customerNo: z.string().optional(),
});

sessionRoutes.post(
  '/:id/ebarimt',
  route(async (req) => {
    const user = await requireUser(req);
    const transactionId = transactionIdOf(req.params.id, 'Гүйлгээний дугаар буруу байна');

    // Only the driver who charged may have the receipt — it carries their
    // money and can be issued to a company TIN.
    const owned = await getTransaction(transactionId);
    if (!owned) throw notFound('Тухайн цэнэглэлтийг олсонгүй');
    if (!user.idTag || user.idTag !== owned.idTag) {
      throw forbidden('Энэ цэнэглэлт өөр бүртгэлд хамаарна');
    }

    const parsed = ebarimtSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('Тэмдэглэсэн талбаруудаа шалгана уу');

    const { type, customerTin, customerNo } = parsed.data;
    if (type === 'B2B_RECEIPT' && (!customerTin || customerTin.trim().length < 5)) {
      throw badRequest('Байгууллагын регистрийн дугаарыг зөв оруулна уу');
    }

    const resolvedCustomerNo =
      type === 'B2C_RECEIPT'
        ? customerNo?.trim() || user.ebarimtCustomerNo || (user.phone && /^\d{8}$/.test(user.phone) ? user.phone : undefined)
        : undefined;

    const session = await requestEBarimt(transactionId, {
      type,
      customerTin: customerTin?.trim(),
      customerNo: resolvedCustomerNo,
    });
    return { session };
  }),
);

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

export const walletRoutes = Router();

walletRoutes.get(
  '/',
  route(async (req) => {
    const user = await requireUser(req);
    const requested = Number(req.query.limit ?? 10);
    // The receipts page reads up to 100 ledger entries in one go.
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 100) : 10;

    const [wallet, entries, cards] = await Promise.all([
      getWallet(user.id),
      listWalletEntries(user.id, limit),
      getSavedCards(user.id),
    ]);

    return { wallet, config: walletConfig(), entries: entries.data, total: entries.total, cards };
  }),
);

const topUpSchema = z.object({
  amount: z
    .number({ message: 'Дүнгээ оруулна уу' })
    .int('Дүн бүхэл тоо байх ёстой')
    .positive('Дүн 0-ээс их байх ёстой'),
  /**
   * `qpay` (default) returns a QR; `card` returns Golomt's `paymentUrl`;
   * `saved_card` charges `cardId` at once and returns the settled payment.
   */
  method: z.enum(['qpay', 'card', 'saved_card', 'socialpay']).default('qpay'),
  saveCard: z.boolean().optional(),
  cardId: z.string().regex(/^[a-f0-9]{24}$/i, 'Карт олдсонгүй').optional(),
});

/**
 * Opens a QPay invoice and returns the QR. No money moves here — the balance
 * changes only once QPay confirms, which `GET /wallet/topup/:id` polls for.
 */
walletRoutes.post(
  '/topup',
  route(async (req) => {
    const user = await requireUser(req);
    // Every unpaid invoice costs a QPay request; keep one driver from opening dozens.
    guard(req, 'wallet-topup', 12, 10 * MINUTE);
    guard(req, 'wallet-topup-hourly', 40, HOUR);

    const { amount, method, saveCard, cardId } = parseBody(req, topUpSchema);
    const config = walletConfig();
    const methodEnabled =
      method === 'card'
        ? config.cardTopUpEnabled
        : method === 'socialpay'
          ? config.socialPayEnabled
          : method === 'saved_card'
          ? config.savedCardsEnabled
          : config.topUpEnabled;
    if (method === 'saved_card') {
      if (!cardId) throw badRequest('Картаа сонгоно уу', { cardId: 'Картаа сонгоно уу' });
      // Each charge reaches the card itself; keep a stolen session from draining it.
      guard(req, 'wallet-card-pay', 6, 10 * MINUTE);
    }

    if (!config.enabled || !methodEnabled) {
      throw badRequest('Цэнэглэх үйлчилгээ түр боломжгүй байна. Дараа дахин оролдоно уу.');
    }
    if (amount < config.minTopUp || amount > config.maxTopUp) {
      throw badRequest(
        `Цэнэглэх дүн ${config.minTopUp.toLocaleString('mn-MN')}₮ – ${config.maxTopUp.toLocaleString(
          'mn-MN',
        )}₮ хооронд байх ёстой`,
        { amount: 'Дүн зөвшөөрөгдөх хязгаараас гадуур байна' },
      );
    }

    const invoice = await createTopUp({
      userId: user.id,
      amount,
      description: `Хэтэвч цэнэглэлт — ${amount.toLocaleString('mn-MN')}₮`,
      receiverCode: user.phone || user.email,
      method,
      saveCard,
      cardId,
    });

    // No QR — the client sends the driver to `paymentUrl` (or the deeplink).
    if (method === 'card' || method === 'socialpay') return { invoice };
    // A saved card settles in the call; the new balance comes along.
    if (method === 'saved_card') {
      const paid = invoice.status === 'PAID';
      return { invoice, paid, wallet: paid ? await getWallet(user.id).catch(() => null) : null };
    }

    // Sent along now so the client can render the QR in one round trip.
    const qr = await getTopUpQr(String(invoice.id));

    return {
      invoice: {
        ...invoice,
        qrText: qr?.qrText ?? invoice.qrText,
        qrImage: qr?.qrImage,
        shortUrl: qr?.shortUrl ?? invoice.shortUrl,
        deeplinks: qr?.deeplinks ?? invoice.deeplinks,
      },
    };
  }),
);

/**
 * Polls one top-up while the QR is on screen. Ownership is checked before QPay
 * is contacted, so a guessed invoice id cannot trigger a lookup.
 */
walletRoutes.get(
  '/topup/:id',
  route(async (req) => {
    const user = await requireUser(req);
    // Bounds polling at roughly one call a second per driver.
    guard(req, 'wallet-topup-check', 90, 2 * MINUTE);

    const existing = await getTopUp(req.params.id!);
    if (!existing) throw notFound('Нэхэмжлэх олдсонгүй');
    if (existing.purpose !== 'WALLET_TOPUP' || existing.walletOwnerId !== user.id) {
      throw forbidden('Энэ нэхэмжлэх таных биш байна');
    }

    // Settled invoices need no further QPay round trip.
    const invoice = existing.status === 'PAID' ? existing : await checkTopUp(req.params.id!);
    const paid = invoice.status === 'PAID';

    return {
      invoice,
      paid,
      // The fresh balance comes along, so a paid QR updates the screen in one step.
      wallet: paid ? await getWallet(user.id).catch(() => null) : null,
    };
  }),
);

/** The driver's saved bank cards (masked; tokens never leave the server). */
walletRoutes.get(
  '/cards',
  route(async (req) => {
    const user = await requireUser(req);
    return { cards: await getSavedCards(user.id) };
  }),
);

walletRoutes.delete(
  '/cards/:id',
  route(async (req) => {
    const user = await requireUser(req);
    const removed = await removeSavedCard(user.id, String(req.params.id ?? ''));
    if (!removed) throw notFound('Карт олдсонгүй');
    return { ok: true };
  }),
);

import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { badRequest, notFound } from '../../lib/errors';
import { Wallet, WALLET_ENTRY_TYPES, WALLET_OWNER_TYPES } from '../../models/Wallet';
import { createPayment, toPaymentView } from '../../services/payment.service';
import {
  balanceOf,
  bindIdTagToWallet,
  credit,
  debit,
  getOrCreateWallet,
  idTagsForWallet,
  listEntries,
  normaliseOwner,
  resolveWalletOwnerForIdTag,
  setWalletStatus,
  toWalletView,
  unbindIdTagFromWallet,
} from '../../services/wallet.service';
import {
  asyncHandler,
  paginate,
  paginationSchema,
  requireAdmin,
  requireAuth,
  requireOperator,
  validate,
} from '../middleware';

/**
 * Prepaid wallets: balance, ledger and QPay top-ups.
 *
 * Wallets are addressed as /wallets/:ownerType/:ownerId — `USER/<accountId>` for
 * a driver account, `IDTAG/<idTag>` for a bare RFID card. Reads and top-ups need
 * an operator credential (the web app calls this from its own server, never from
 * the browser); manual balance corrections need an admin.
 */
export const walletsRouter = Router();

walletsRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Config — presets the front ends render, so the amounts live in one place.
// ---------------------------------------------------------------------------

walletsRouter.get(
  '/config',
  asyncHandler(async (_req, res) => {
    res.json({
      enabled: env.WALLET_ENABLED,
      currency: 'MNT',
      presets: env.WALLET_TOPUP_PRESETS,
      minTopUp: env.WALLET_TOPUP_MIN,
      maxTopUp: env.WALLET_TOPUP_MAX,
      minStartBalance: env.WALLET_MIN_START_BALANCE,
      requireBalanceToStart: env.WALLET_REQUIRE_BALANCE_TO_START,
      allowNegative: env.WALLET_ALLOW_NEGATIVE,
      topUpEnabled: env.QPAY_ENABLED,
    });
  }),
);

/**
 * Resolve which wallet a card spends from — used by a charger or kiosk that has
 * just read a tag. Declared before /:ownerType/:ownerId, which would otherwise
 * match 'by-id-tag' as an owner type.
 */
walletsRouter.get(
  '/by-id-tag/:idTag',
  validate(z.object({ idTag: z.string().min(1).max(64) }), 'params'),
  asyncHandler(async (req, res) => {
    const { idTag } = req.params as { idTag: string };
    const owner = await resolveWalletOwnerForIdTag(idTag);
    if (!owner) throw notFound(`idTag ${idTag} not found`);
    const wallet = await getOrCreateWallet(owner);
    res.json({ idTag, ...toWalletView(wallet) });
  }),
);

// ---------------------------------------------------------------------------
// Listing (operator console)
// ---------------------------------------------------------------------------

const listQuery = paginationSchema.extend({
  ownerType: z.enum(WALLET_OWNER_TYPES).optional(),
  status: z.enum(['ACTIVE', 'FROZEN']).optional(),
  /** Only wallets carrying a debt, so an operator can chase them. */
  negative: z.coerce.boolean().optional(),
  q: z.string().trim().min(1).max(64).optional(),
});

walletsRouter.get(
  '/',
  requireOperator,
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const filter: Record<string, unknown> = {};
    if (q.ownerType) filter.ownerType = q.ownerType;
    if (q.status) filter.status = q.status;
    if (q.negative) filter.balance = { $lt: 0 };
    if (q.q) filter.ownerId = { $regex: q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };

    const { skip, limit } = paginate(q);
    const [data, total] = await Promise.all([
      Wallet.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
      Wallet.countDocuments(filter),
    ]);

    res.json({ data: data.map(toWalletView), total, page: q.page, limit: q.limit });
  }),
);

// ---------------------------------------------------------------------------
// One wallet
// ---------------------------------------------------------------------------

const ownerParams = z.object({
  ownerType: z.string(),
  ownerId: z.string().min(1).max(128),
});

/** Reads the :ownerType/:ownerId pair off the request, rejecting bad values. */
function ownerOf(req: { params: unknown }) {
  const { ownerType, ownerId } = req.params as z.infer<typeof ownerParams>;
  return normaliseOwner(ownerType, ownerId);
}

/**
 * The wallet, created empty on first read. A driver who has never topped up
 * should see a zero balance, not a 404 they have to interpret.
 */
walletsRouter.get(
  '/:ownerType/:ownerId',
  validate(ownerParams, 'params'),
  asyncHandler(async (req, res) => {
    const owner = ownerOf(req);
    const wallet = await getOrCreateWallet(owner);
    const idTags = await idTagsForWallet(owner);
    res.json({ ...toWalletView(wallet), idTags });
  }),
);

/** Balance only — the cheap poll a kiosk or a header badge can hit often. */
walletsRouter.get(
  '/:ownerType/:ownerId/balance',
  validate(ownerParams, 'params'),
  asyncHandler(async (req, res) => {
    const owner = ownerOf(req);
    res.json({
      ...owner,
      balance: await balanceOf(owner),
      currency: 'MNT',
    });
  }),
);

const entriesQuery = paginationSchema.extend({
  type: z.enum(WALLET_ENTRY_TYPES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

walletsRouter.get(
  '/:ownerType/:ownerId/entries',
  validate(ownerParams, 'params'),
  validate(entriesQuery, 'query'),
  asyncHandler(async (req, res) => {
    const owner = ownerOf(req);
    const q = req.query as unknown as z.infer<typeof entriesQuery>;
    const { skip, limit } = paginate(q);
    const { data, total } = await listEntries(owner, {
      type: q.type,
      from: q.from,
      to: q.to,
      skip,
      limit,
    });
    res.json({ data, total, page: q.page, limit: q.limit });
  }),
);

// ---------------------------------------------------------------------------
// Top-up — creates a QPay invoice tagged WALLET_TOPUP. The balance moves only
// when QPay confirms payment (callback or /payments/:id/check), never here.
// ---------------------------------------------------------------------------

const topUpSchema = z.object({
  amount: z.number().int().positive(),
  description: z.string().min(1).max(255).optional(),
  /** Ties the top-up to a card, so a kiosk receipt can name it. */
  idTag: z.string().max(64).optional(),
  /** QPay's invoice_receiver_code — a phone number or customer reference. */
  receiverCode: z.string().min(1).max(45).optional(),
  expiryMinutes: z.number().int().min(1).max(1440).optional(),
});

walletsRouter.post(
  '/:ownerType/:ownerId/topup',
  requireOperator,
  validate(ownerParams, 'params'),
  validate(topUpSchema),
  asyncHandler(async (req, res) => {
    const owner = ownerOf(req);
    const body = req.body as z.infer<typeof topUpSchema>;

    if (body.amount < env.WALLET_TOPUP_MIN || body.amount > env.WALLET_TOPUP_MAX) {
      throw badRequest(
        `Top-up must be between ${env.WALLET_TOPUP_MIN} and ${env.WALLET_TOPUP_MAX} MNT`,
      );
    }

    // Make sure the wallet exists before QPay does, so a callback arriving
    // moments later has somewhere to credit.
    await getOrCreateWallet(owner);

    const payment = await createPayment({
      amount: body.amount,
      description: body.description ?? `Хэтэвч цэнэглэлт — ${body.amount.toLocaleString('mn-MN')}₮`,
      purpose: 'WALLET_TOPUP',
      walletOwnerType: owner.ownerType,
      walletOwnerId: owner.ownerId,
      idTag: body.idTag,
      userId: owner.ownerType === 'USER' ? owner.ownerId : undefined,
      receiverCode: body.receiverCode ?? body.idTag ?? owner.ownerId,
      expiryMinutes: body.expiryMinutes,
    });

    res.status(201).json(toPaymentView(payment));
  }),
);

// ---------------------------------------------------------------------------
// Card binding — points an idTag at this wallet so charges draw on it.
// ---------------------------------------------------------------------------

const idTagBody = z.object({ idTag: z.string().trim().min(1).max(64) });

walletsRouter.post(
  '/:ownerType/:ownerId/id-tags',
  requireOperator,
  validate(ownerParams, 'params'),
  validate(idTagBody),
  asyncHandler(async (req, res) => {
    const owner = ownerOf(req);
    const { idTag } = req.body as z.infer<typeof idTagBody>;
    await bindIdTagToWallet(idTag, owner);
    res.json({ ...owner, idTags: await idTagsForWallet(owner) });
  }),
);

walletsRouter.delete(
  '/:ownerType/:ownerId/id-tags/:idTag',
  requireOperator,
  validate(ownerParams.extend({ idTag: z.string().min(1).max(64) }), 'params'),
  asyncHandler(async (req, res) => {
    const owner = ownerOf(req);
    const { idTag } = req.params as { idTag: string };
    await unbindIdTagFromWallet(idTag);
    res.json({ ...owner, idTags: await idTagsForWallet(owner) });
  }),
);

// ---------------------------------------------------------------------------
// Manual corrections (admin only) — refunds, goodwill credits, write-offs.
// ---------------------------------------------------------------------------

const adjustSchema = z.object({
  /** Signed: positive credits the wallet, negative debits it. */
  amount: z.number().int().refine((n) => n !== 0, 'amount must not be zero'),
  reason: z.string().min(1).max(255),
  type: z.enum(['ADJUSTMENT', 'BONUS', 'REFUND']).optional(),
});

walletsRouter.post(
  '/:ownerType/:ownerId/adjust',
  requireAdmin,
  validate(ownerParams, 'params'),
  validate(adjustSchema),
  asyncHandler(async (req, res) => {
    const owner = ownerOf(req);
    const body = req.body as z.infer<typeof adjustSchema>;
    const by = req.user?.email ?? 'admin';

    const movement =
      body.amount > 0
        ? await credit(owner, body.amount, body.type ?? 'ADJUSTMENT', {
            description: body.reason,
            createdBy: by,
          })
        : await debit(
            owner,
            Math.abs(body.amount),
            'ADJUSTMENT',
            { description: body.reason, createdBy: by },
            { allowNegative: true },
          );

    res.json({
      ...toWalletView(movement.wallet),
      entryId: movement.entryId,
      applied: movement.amount,
    });
  }),
);

walletsRouter.post(
  '/:ownerType/:ownerId/freeze',
  requireAdmin,
  validate(ownerParams, 'params'),
  asyncHandler(async (req, res) => {
    res.json(toWalletView(await setWalletStatus(ownerOf(req), 'FROZEN')));
  }),
);

walletsRouter.post(
  '/:ownerType/:ownerId/unfreeze',
  requireAdmin,
  validate(ownerParams, 'params'),
  asyncHandler(async (req, res) => {
    res.json(toWalletView(await setWalletStatus(ownerOf(req), 'ACTIVE')));
  }),
);

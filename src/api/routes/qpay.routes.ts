import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { serviceUnavailable } from '../../lib/errors';
import * as quickqr from '../../services/qpay/quickqr.client';
import { invalidateToken, tokenStatus } from '../../services/qpay/tokens';
import { QpayMerchantConfig, ensureDefaultQpayMerchantConfig } from '../../models/QpayMerchantConfig';
import { asyncHandler, requireAdmin, requireAuth, requireOperator, validate } from '../middleware';

/**
 * QuickQR sub-merchant administration (quickqr.qpay.mn). Separate from
 * /payments because it manages QPay-side merchants rather than money movement.
 */
export const qpayRouter = Router();

qpayRouter.use(requireAuth, requireOperator);

qpayRouter.use((_req, _res, next) => {
  if (!env.QPAY_QUICKQR_ENABLED) {
    next(serviceUnavailable('QuickQR integration is disabled (QPAY_QUICKQR_ENABLED=false)'));
    return;
  }
  if (!env.QPAY_QUICKQR_TERMINAL_ID) {
    next(serviceUnavailable('QPAY_QUICKQR_TERMINAL_ID is not configured'));
    return;
  }
  next();
});

const activeMerchantSchema = z.object({
  merchantId: z.string().min(1).max(255),
  merchantName: z.string().max(255).optional(),
  mccCode: z.string().min(1).max(255).default('5311'),
  bankCode: z.string().min(1).max(255).default('050000'),
  accountNumber: z.string().min(1).max(255),
  accountName: z.string().min(1).max(255),
});

qpayRouter.get(
  '/active-merchant',
  asyncHandler(async (_req, res) => {
    await ensureDefaultQpayMerchantConfig();
    const config = await QpayMerchantConfig.findOne({ isActive: true }).lean();
    if (!config) {
      res.json({
        merchantId: env.QPAY_QUICKQR_MERCHANT_ID || 'cc1a2b2f-aa84-474a-953c-c55b575a9883',
        merchantName: env.QPAY_QUICKQR_ACCOUNT_NAME || 'ЗЭВ ТАБС ХХК',
        mccCode: env.QPAY_QUICKQR_MCC_CODE || '5311',
        bankCode: env.QPAY_QUICKQR_BANK_CODE || '050000',
        accountNumber: env.QPAY_QUICKQR_ACCOUNT_NUMBER || '5475332224',
        accountName: env.QPAY_QUICKQR_ACCOUNT_NAME || 'ЗЭВ ТАБС ХХК',
        isActive: true,
      });
      return;
    }
    res.json({
      ...config,
      id: String(config._id),
    });
  }),
);

qpayRouter.put(
  '/active-merchant',
  validate(activeMerchantSchema),
  asyncHandler(async (req, res) => {
    const data = req.body as z.infer<typeof activeMerchantSchema>;
    await QpayMerchantConfig.updateMany({}, { isActive: false });

    const updated = await QpayMerchantConfig.findOneAndUpdate(
      { merchantId: data.merchantId },
      {
        merchantId: data.merchantId,
        merchantName: data.merchantName ?? data.accountName,
        mccCode: data.mccCode,
        bankCode: data.bankCode,
        accountNumber: data.accountNumber,
        accountName: data.accountName,
        isActive: true,
        updatedBy: req.user?.email ?? req.user?.id,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();

    res.json({
      ...updated,
      id: String(updated._id),
    });
  }),
);

qpayRouter.get(
  '/tokens',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json([tokenStatus('merchant'), tokenStatus('quickqr')]);
  }),
);

/** Drop the cached token so the next call re-authenticates from scratch. */
qpayRouter.post(
  '/tokens/:scope/invalidate',
  requireAdmin,
  validate(z.object({ scope: z.enum(['merchant', 'quickqr']) }), 'params'),
  asyncHandler(async (req, res) => {
    const { scope } = req.params as unknown as { scope: 'merchant' | 'quickqr' };
    await invalidateToken(scope);
    res.json({ scope, invalidated: true });
  }),
);

qpayRouter.get(
  '/cities',
  asyncHandler(async (_req, res) => {
    res.json(await quickqr.listCities());
  }),
);

qpayRouter.get(
  '/cities/:cityCode/districts',
  asyncHandler(async (req, res) => {
    res.json(await quickqr.listDistricts(req.params.cityCode));
  }),
);

const companySchema = z.object({
  register_number: z.string().max(255),
  company_name: z.string().max(255),
  name: z.string().max(255),
  mcc_code: z.string().max(255),
  city: z.string().max(255),
  district: z.string().max(255),
  address: z.string().max(255),
  phone: z.string().max(255),
  email: z.string().email(),
  name_eng: z.string().max(255).optional(),
  owner_first_name: z.string().max(255).optional(),
  owner_last_name: z.string().max(255).optional(),
  owner_register_no: z.string().max(255).optional(),
  location_lat: z.string().optional(),
  location_lng: z.string().optional(),
  max_qr_account_count: z.number().int().positive().optional(),
});

const personSchema = z.object({
  register_number: z.string().max(255),
  first_name: z.string().max(255),
  last_name: z.string().max(255),
  business_name: z.string().max(255),
  mcc_code: z.string().max(255),
  city: z.string().max(255),
  district: z.string().max(255),
  address: z.string().max(255),
  phone: z.string().max(255),
  email: z.string().email(),
  business_name_eng: z.string().max(255).optional(),
  max_qr_account_count: z.number().int().positive().optional(),
});

function normalizeMerchant(m: any): any {
  if (!m || typeof m !== 'object') return m;
  const mid = m.merchant_id || m.id || m.merchantId || m._id;
  return {
    ...m,
    merchant_id: mid ? String(mid).trim() : undefined,
    id: mid ? String(mid).trim() : undefined,
  };
}

qpayRouter.post(
  '/merchants/company',
  validate(companySchema),
  asyncHandler(async (req, res) => {
    const created = await quickqr.createCompanyMerchant(req.body as z.infer<typeof companySchema>);
    res.status(201).json(normalizeMerchant(created));
  }),
);

qpayRouter.put(
  '/merchants/company/:merchantId',
  validate(companySchema),
  asyncHandler(async (req, res) => {
    const updated = await quickqr.updateCompanyMerchant(
      req.params.merchantId,
      req.body as z.infer<typeof companySchema>,
    );
    res.json(normalizeMerchant(updated));
  }),
);

qpayRouter.post(
  '/merchants/person',
  validate(personSchema),
  asyncHandler(async (req, res) => {
    const created = await quickqr.createPersonMerchant(req.body as z.infer<typeof personSchema>);
    res.status(201).json(normalizeMerchant(created));
  }),
);

qpayRouter.put(
  '/merchants/person/:merchantId',
  validate(personSchema),
  asyncHandler(async (req, res) => {
    const updated = await quickqr.updatePersonMerchant(
      req.params.merchantId,
      req.body as z.infer<typeof personSchema>,
    );
    res.json(normalizeMerchant(updated));
  }),
);

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

qpayRouter.get(
  '/merchants',
  validate(listSchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listSchema>;
    const resList = (await quickqr.listMerchants(q.page, q.limit)) as any;
    if (resList && Array.isArray(resList.rows)) {
      resList.rows = resList.rows.map(normalizeMerchant);
    } else if (Array.isArray(resList)) {
      return res.json(resList.map(normalizeMerchant));
    }
    res.json(resList);
  }),
);

qpayRouter.get(
  '/merchants/:merchantId',
  asyncHandler(async (req, res) => {
    const m = await quickqr.getMerchant(req.params.merchantId);
    res.json(normalizeMerchant(m));
  }),
);

qpayRouter.delete(
  '/merchants/:merchantId',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await quickqr.deleteMerchant(req.params.merchantId));
  }),
);

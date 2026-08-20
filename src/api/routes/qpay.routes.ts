import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { serviceUnavailable } from '../../lib/errors';
import * as quickqr from '../../services/qpay/quickqr.client';
import { invalidateToken, tokenStatus } from '../../services/qpay/tokens';
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

qpayRouter.post(
  '/merchants/company',
  validate(companySchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await quickqr.createCompanyMerchant(req.body as z.infer<typeof companySchema>));
  }),
);

qpayRouter.put(
  '/merchants/company/:merchantId',
  validate(companySchema),
  asyncHandler(async (req, res) => {
    res.json(
      await quickqr.updateCompanyMerchant(
        req.params.merchantId,
        req.body as z.infer<typeof companySchema>,
      ),
    );
  }),
);

qpayRouter.post(
  '/merchants/person',
  validate(personSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await quickqr.createPersonMerchant(req.body as z.infer<typeof personSchema>));
  }),
);

qpayRouter.put(
  '/merchants/person/:merchantId',
  validate(personSchema),
  asyncHandler(async (req, res) => {
    res.json(
      await quickqr.updatePersonMerchant(
        req.params.merchantId,
        req.body as z.infer<typeof personSchema>,
      ),
    );
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
    res.json(await quickqr.listMerchants(q.page, q.limit));
  }),
);

qpayRouter.get(
  '/merchants/:merchantId',
  asyncHandler(async (req, res) => {
    res.json(await quickqr.getMerchant(req.params.merchantId));
  }),
);

qpayRouter.delete(
  '/merchants/:merchantId',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await quickqr.deleteMerchant(req.params.merchantId));
  }),
);

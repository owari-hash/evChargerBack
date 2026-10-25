import { Router } from 'express';
import { z } from 'zod';
import {
  asyncHandler,
  paginationSchema,
  requireAuth,
  requireOperator,
  validate,
} from '../middleware';
import {
  listEbarimtReceipts,
  returnEBarimtReceipt,
} from '../../services/ebarimt.service';
import { Transaction } from '../../models/Transaction';
import { Payment } from '../../models/Payment';
import { notFound } from '../../lib/errors';
import { store } from '../../driver/store';

export const ebarimtRouter = Router();

ebarimtRouter.use(requireAuth);

const listQuery = paginationSchema.extend({
  status: z.enum(['ALL', 'SUCCESS', 'REFUNDED', 'FAILED', 'PENDING']).default('ALL').optional(),
  type: z.enum(['B2C_RECEIPT', 'B2B_RECEIPT']).optional(),
  q: z.string().trim().max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  chargePointId: z.string().optional(),
});

/**
 * GET /ebarimt
 * List e-barimt receipts across transactions and payments with stats summary.
 */
ebarimtRouter.get(
  '/',
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const result = await listEbarimtReceipts(q);
    res.json(result);
  }),
);

const returnSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  source: z.enum(['TRANSACTION', 'PAYMENT']).optional(),
  receiptId: z.string().optional(),
  reason: z.string().max(255).optional(),
});

/**
 * POST /ebarimt/return
 * Cancel/return an e-barimt receipt from the national tax system via PosAPI DELETE /rest/receipt.
 */
ebarimtRouter.post(
  '/return',
  requireOperator,
  validate(returnSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof returnSchema>;
    const returnedBy = req.user?.email || 'operator';
    const result = await returnEBarimtReceipt({
      id: body.id,
      source: body.source,
      receiptId: body.receiptId,
      returnedBy,
      reason: body.reason,
    });
    res.json(result);
  }),
);

/**
 * POST /ebarimt/:id/return
 * Convenience endpoint by receipt ID (e.g. "tx_123" or "pay_456" or numeric/DDTD).
 */
ebarimtRouter.post(
  '/:id/return',
  requireOperator,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const body = (req.body || {}) as { reason?: string };
    const returnedBy = req.user?.email || 'operator';
    const result = await returnEBarimtReceipt({
      id,
      returnedBy,
      reason: body.reason,
    });
    res.json(result);
  }),
);

/**
 * GET /ebarimt/:id
 * Retrieve detail of a single receipt.
 */
ebarimtRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const rawId = req.params.id;
    let row: any = null;

    if (rawId.startsWith('tx_') || /^\d+$/.test(rawId)) {
      const txId = Number(rawId.replace(/^tx_/, ''));
      const tx = await Transaction.findById(txId).lean();
      if (tx?.ebarimt) {
        const driver = tx.idTag ? await store.findUserByIdTag(tx.idTag).catch(() => null) : null;
        row = {
          id: `tx_${tx._id}`,
          source: 'TRANSACTION',
          sourceId: tx._id,
          receiptId: tx.ebarimt.receiptId,
          lottery: tx.ebarimt.lottery,
          qrData: tx.ebarimt.qrData,
          type: tx.ebarimt.type || 'B2C_RECEIPT',
          status: tx.ebarimt.status || 'SUCCESS',
          totalAmount: tx.ebarimt.totalAmount || tx.cost || 0,
          totalVAT: tx.ebarimt.totalVAT || 0,
          merchantTin: tx.ebarimt.merchantTin,
          customerNo: tx.ebarimt.customerNo,
          customerTin: tx.ebarimt.customerTin,
          issuedAt: tx.ebarimt.issuedAt,
          returnedAt: tx.ebarimt.returnedAt,
          returnedBy: (tx.ebarimt as any).returnedBy,
          error: tx.ebarimt.error,
          chargePointId: String(tx.chargePointId),
          connectorId: tx.connectorId,
          driver: driver ? { name: driver.name, phone: driver.phone } : null,
          rawResponse: tx.ebarimt.rawResponse,
          returnResponse: tx.ebarimt.returnResponse,
        };
      }
    }

    if (!row) {
      const payId = rawId.replace(/^pay_/, '');
      const pay = await Payment.findById(payId).lean().catch(() => null);
      if (pay?.ebarimt) {
        const uId = pay.userId || pay.walletOwnerId;
        const driver = uId ? await store.findUserById(uId).catch(() => null) : null;
        row = {
          id: `pay_${pay._id}`,
          source: 'PAYMENT',
          sourceId: String(pay._id),
          receiptId: pay.ebarimt.receiptId,
          lottery: pay.ebarimt.lottery,
          qrData: pay.ebarimt.qrData,
          type: pay.ebarimt.type || 'B2C_RECEIPT',
          status: pay.ebarimt.status || 'SUCCESS',
          totalAmount: pay.ebarimt.totalAmount || pay.paidAmount || pay.amount || 0,
          totalVAT: pay.ebarimt.totalVAT || 0,
          merchantTin: pay.ebarimt.merchantTin,
          customerNo: pay.ebarimt.customerNo,
          customerTin: pay.ebarimt.customerTin,
          issuedAt: pay.ebarimt.issuedAt,
          returnedAt: pay.ebarimt.returnedAt,
          returnedBy: (pay.ebarimt as any).returnedBy,
          error: pay.ebarimt.error,
          chargePointId: pay.chargePointId ? String(pay.chargePointId) : undefined,
          connectorId: pay.connectorId !== null && pay.connectorId !== undefined ? pay.connectorId : undefined,
          driver: driver ? { name: driver.name, phone: driver.phone } : null,
          rawResponse: pay.ebarimt.rawResponse,
          returnResponse: pay.ebarimt.returnResponse,
        };
      }
    }

    if (!row) {
      throw notFound('И-баримт олдсонгүй');
    }

    res.json(row);
  }),
);

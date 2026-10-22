import { Router } from 'express';
import { env } from '../../config/env';
import { HttpError } from '../../lib/errors';
import { Payment } from '../../models/Payment';
import {
  GOLOMT_TRANSACTION_ID,
  handleGolomtNotification,
  syncPayment,
} from '../../services/payment.service';
import { driverLogger } from '../http';

/**
 * Where a payment provider sends the driver's browser back to. No session is
 * needed: the handler only asks the bank how the payment stands — whatever the
 * bank appended to the URL is ignored — and then hands the driver to the
 * wallet page, which shows the outcome to its owner.
 */
export const paymentRoutes = Router();

paymentRoutes.get('/golomt/return/:transactionId', async (req, res) => {
  const transactionId = String(req.params.transactionId ?? '');
  const wallet = new URL('/account/wallet', env.APP_URL);

  if (GOLOMT_TRANSACTION_ID.test(transactionId)) {
    const payment = await Payment.findOne({ senderInvoiceNo: transactionId, provider: 'GOLOMT' }).catch(
      () => null,
    );
    if (payment) {
      wallet.searchParams.set('topup', String(payment._id));
      // Settle now so the balance is already right when the page loads; the
      // page and the reconcile sweep both retry if the bank is slow.
      await syncPayment(payment).catch((err: unknown) =>
        driverLogger.warn({ transactionId, err: (err as Error).message }, 'golomt return sync failed'),
      );
    }
  }

  res.redirect(303, wallet.toString());
});

/**
 * Golomt's push notification — the URL registered with the bank:
 *   https://eplug.mn/app-api/payments/golomt/notify
 *
 * The bank requires it to accept POST only. The body is verified against our
 * HMAC key before anything is read from it, and the payment is then re-checked
 * with the bank, so a forged or replayed push can change nothing.
 */
paymentRoutes.post('/golomt/notify', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    await handleGolomtNotification(body);
    res.json({ status: 'OK' });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    driverLogger.warn(
      { transactionId: body.transactionId, status, err: (err as Error).message },
      'golomt notification rejected',
    );
    res.status(status).json({ status: 'ERROR', message: (err as Error).message });
  }
});

paymentRoutes.all('/golomt/notify', (_req, res) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json({ status: 'ERROR', message: 'Method not allowed' });
});

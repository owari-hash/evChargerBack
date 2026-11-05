import { randomBytes } from 'node:crypto';
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
 * The same return for a card page the app opened: settle with the bank, then
 * hand the driver back to the app (`eplug://wallet/topup?id=…`), which closes
 * its in-app browser and plays the result. A small page rather than a bare
 * redirect, because some in-app browsers only follow an app link on a tap.
 */
paymentRoutes.get('/golomt/return-app/:transactionId', async (req, res) => {
  const transactionId = String(req.params.transactionId ?? '');
  let paymentId = '';

  if (GOLOMT_TRANSACTION_ID.test(transactionId)) {
    const payment = await Payment.findOne({ senderInvoiceNo: transactionId, provider: 'GOLOMT' }).catch(
      () => null,
    );
    if (payment) {
      paymentId = String(payment._id);
      await syncPayment(payment).catch((err: unknown) =>
        driverLogger.warn({ transactionId, err: (err as Error).message }, 'golomt app return sync failed'),
      );
    }
  }

  // Only a Mongo id ever goes into the link, so nothing here needs escaping
  // beyond refusing anything else.
  const safeId = /^[a-f0-9]{24}$/i.test(paymentId) ? paymentId : '';
  const appLink = `eplug://wallet/topup${safeId ? `?id=${safeId}` : ''}`;
  // Helmet's default CSP blocks inline script; this page allows only its own.
  const nonce = randomBytes(16).toString('base64');

  res
    .status(200)
    .type('html')
    .setHeader('Cache-Control', 'no-store')
    .setHeader(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`,
    )
    .send(`<!doctype html>
<html lang="mn"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Eplug</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07110d;color:#e7f3ec;
    font:16px/1.5 system-ui,-apple-system,sans-serif;text-align:center;padding:24px;box-sizing:border-box}
  .dot{width:56px;height:56px;margin:0 auto 18px;border-radius:50%;
    border:4px solid #10b98133;border-top-color:#10b981;animation:spin 0.9s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  a{display:inline-block;margin-top:20px;padding:14px 26px;border-radius:14px;background:#10b981;
    color:#04120b;font-weight:700;text-decoration:none}
  p{margin:6px 0;color:#9fb8aa;font-size:14px}
</style></head>
<body><div>
  <div class="dot"></div>
  <strong>Апп руу буцаж байна…</strong>
  <p>Returning to the Eplug app…</p>
  <a href="${appLink}">Апп руу буцах</a>
</div>
<script nonce="${nonce}">location.replace(${JSON.stringify(appLink)});</script>
</body></html>`);
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

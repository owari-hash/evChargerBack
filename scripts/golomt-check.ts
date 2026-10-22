/**
 * Golomt e-commerce connectivity check — run after deploying new GOLOMT_* keys.
 *
 *   npm run golomt:check
 *
 * Opens one 100₮ invoice (never paid, it simply lapses on the bank's side),
 * reads it back with /api/inquiry and verifies both signatures, which proves
 * the token, the HMAC key and the network path together. When token payments
 * are switched on it also asks whether the bank has enabled them. Nothing is
 * written to the database and no secret is printed.
 */
import { env, golomtReturnUrl } from '../src/config/env';
import * as golomt from '../src/services/golomt/client';

async function main(): Promise<void> {
  console.log(`Golomt: ${env.GOLOMT_BASE_URL} (enabled=${env.GOLOMT_ENABLED}, tokens=${env.GOLOMT_TOKEN_ENABLED})`);
  if (!env.GOLOMT_ENABLED) {
    console.error('GOLOMT_ENABLED is false — nothing to check.');
    process.exitCode = 1;
    return;
  }
  console.log(`Return URL:  ${golomtReturnUrl('<transactionId>')}`);
  console.log(`Push URL:    ${env.GOLOMT_CALLBACK_BASE_URL ?? env.PUBLIC_BASE_URL}${env.DRIVER_API_BASE_PATH}/payments/golomt/notify`);

  const transactionId = `C${Date.now().toString(16).toUpperCase().slice(-15)}`;
  try {
    const inv = await golomt.createInvoice({
      transactionId,
      amount: 100,
      callback: golomtReturnUrl(transactionId),
    });
    console.log(`Invoice OK (signature verified): ${golomt.paymentPageUrl(inv.invoice)}`);
  } catch (err) {
    console.error(`Invoice FAILED — ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  try {
    const r = await golomt.inquiry(transactionId);
    if (!r.verified) throw new Error('inquiry reply failed checksum verification');
    console.log(`Inquiry OK (signature verified): status=${r.status} amount=${r.amountText}`);
  } catch (err) {
    console.error(`Inquiry FAILED — ${(err as Error).message}`);
    process.exitCode = 1;
  }

  if (env.GOLOMT_TOKEN_ENABLED) {
    try {
      await golomt.checkToken(transactionId);
      console.log('Token API reachable');
    } catch (err) {
      const message = (err as Error).message;
      if (/not allowed to do token/i.test(message)) {
        console.error('Token payments are NOT enabled for this merchant — ask Golomt, or set GOLOMT_TOKEN_ENABLED=false.');
        process.exitCode = 1;
      } else {
        // "Payment not found" is the expected answer for a non-token id.
        console.log(`Token API reachable (${message})`);
      }
    }
  }
}

void main();

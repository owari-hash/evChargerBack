/**
 * QPay connectivity check.
 *
 *   npm run qpay:check                verify the configured provider end to end
 *   npm run qpay:check -- --merchant  also try the merchant API credentials
 *
 * Authenticates, exercises one read-only call and reports token lifetimes.
 * No invoice is created and no token is ever printed.
 */
import { env, qpayMerchantBaseUrl } from '../src/config/env';
import { connectDatabase, disconnectDatabase } from '../src/lib/db';
import { logger } from '../src/lib/logger';
import { QpayError } from '../src/services/qpay/http';
import * as qpayMerchant from '../src/services/qpay/merchant.client';
import * as quickqr from '../src/services/qpay/quickqr.client';
import { getAccessToken, tokenStatus } from '../src/services/qpay/tokens';

const fail = (label: string, err: unknown): void => {
  const e = err as Error;
  const detail = err instanceof QpayError ? `HTTP ${err.status} ${err.message}` : e.message;
  logger.error(`${label}: FAILED — ${detail}`);
};

async function checkQuickQr(): Promise<void> {
  logger.info(`QuickQR: ${env.QPAY_QUICKQR_URL}, terminal ${env.QPAY_QUICKQR_TERMINAL_ID}`);
  try {
    await getAccessToken('quickqr');
    const status = tokenStatus('quickqr');
    logger.info(
      `QuickQR auth OK — access token valid until ${status.accessExpiresAt}` +
        `${status.hasRefreshToken ? ', refresh token stored' : ', no refresh token'}`,
    );
  } catch (err) {
    fail('QuickQR auth', err);
    return;
  }

  try {
    const cities = await quickqr.listCities();
    logger.info(`QuickQR read OK — ${cities.length} cities returned`);
  } catch (err) {
    fail('QuickQR GET /v2/aimaghot', err);
  }

  const merchantId = env.QPAY_QUICKQR_MERCHANT_ID;
  if (!merchantId) {
    logger.warn(
      'QPAY_QUICKQR_MERCHANT_ID is not set — invoices will be rejected until a ' +
        'sub-merchant exists (POST /api/qpay/merchants/company)',
    );
    return;
  }
  try {
    await quickqr.getMerchant(merchantId);
    logger.info(`QuickQR merchant ${merchantId} exists`);
  } catch (err) {
    fail(`QuickQR merchant ${merchantId}`, err);
  }
}

async function checkMerchant(): Promise<void> {
  logger.info(`Merchant API: ${qpayMerchantBaseUrl()} (mode ${env.QPAY_MODE})`);
  try {
    await getAccessToken('merchant');
    logger.info(`Merchant auth OK — token valid until ${tokenStatus('merchant').accessExpiresAt}`);
  } catch (err) {
    fail('Merchant auth', err);
    return;
  }
  // A lookup of an obviously absent invoice: proves the token is accepted.
  try {
    await qpayMerchant.getInvoice('00000000-0000-0000-0000-000000000000');
    logger.info('Merchant read OK');
  } catch (err) {
    if (err instanceof QpayError && err.status === 404) {
      logger.info('Merchant read OK — token accepted (404 for the probe invoice, as expected)');
      return;
    }
    fail('Merchant GET /v2/invoice/:id', err);
  }
}

async function main(): Promise<void> {
  if (!env.QPAY_ENABLED) logger.warn('QPAY_ENABLED is false — checking the configuration anyway');
  if (!env.QPAY_USERNAME || !env.QPAY_PASSWORD) {
    logger.error('QPAY_USERNAME / QPAY_PASSWORD are not set');
    return;
  }

  // The token cache lives in MongoDB, so a connection is required.
  await connectDatabase();

  const only = process.argv.slice(2);
  const wantMerchant = only.includes('--merchant') || env.QPAY_DEFAULT_PROVIDER === 'merchant';

  if (env.QPAY_QUICKQR_TERMINAL_ID) await checkQuickQr();
  else logger.warn('QPAY_QUICKQR_TERMINAL_ID is not set — skipping the QuickQR check');

  if (wantMerchant) await checkMerchant();
}

main()
  .then(() => disconnectDatabase())
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'qpay check failed');
    process.exit(1);
  });

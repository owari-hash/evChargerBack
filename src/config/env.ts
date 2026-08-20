import 'dotenv/config';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v.toLowerCase() === 'true' || v === '1'));

/** Normalise a mount path: always a leading slash, never a trailing one. */
const path = (def: string) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const raw = (v ?? '').trim() || def;
      const lead = raw.startsWith('/') ? raw : `/${raw}`;
      return lead === '/' ? '' : lead.replace(/\/+$/, '');
    });

const url = (def: string) =>
  z
    .string()
    .optional()
    .transform((v) => ((v ?? '').trim() || def).replace(/\/+$/, ''))
    .pipe(z.string().url());

/** Optional string where an empty/whitespace value in .env means "not set". */
const opt = z
  .string()
  .optional()
  .transform((v) => {
    const trimmed = v?.trim();
    return trimmed ? trimmed : undefined;
  });

/** Same, but preserves surrounding whitespace (passwords, secrets). */
const optRaw = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HTTP_PORT: int(3000),
  HTTP_HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  CORS_ORIGIN: z.string().default('*'),
  /** Public origin the API is reached at through the reverse proxy. */
  PUBLIC_BASE_URL: z
    .string()
    .url()
    .default('https://eplug.mn')
    .transform((v) => v.replace(/\/+$/, '')),
  /** Path every REST route is mounted under, e.g. https://eplug.mn/api/... */
  API_BASE_PATH: path('/api'),

  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/csms'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  ADMIN_EMAIL: z.string().email().default('admin@example.com'),
  ADMIN_PASSWORD: z.string().default('ChangeMe123!'),
  API_KEY: z.string().optional(),

  OCPP_PATH_PREFIX: path('/ocpp'),
  OCPP_SECURITY_PROFILE: int(1).pipe(z.number().int().min(1).max(3)),
  OCPP_REQUIRE_KNOWN_CHARGEPOINT: bool(false),
  OCPP_ALLOW_ANONYMOUS: bool(true),
  OCPP_HEARTBEAT_INTERVAL: int(300),
  OCPP_CALL_TIMEOUT_MS: int(30_000),
  OCPP_PING_INTERVAL_MS: int(30_000),
  OCPP_LOG_MESSAGES: bool(true),
  OCPP_LOG_RETENTION_DAYS: int(30),

  // ---------- QPay (merchant API + QuickQR) ----------
  QPAY_ENABLED: bool(false),
  /** sandbox -> merchant-sandbox.qpay.mn, production -> merchant.qpay.mn */
  QPAY_MODE: z.enum(['sandbox', 'production']).default('sandbox'),
  QPAY_MERCHANT_SANDBOX_URL: url('https://merchant-sandbox.qpay.mn'),
  QPAY_MERCHANT_PRODUCTION_URL: url('https://merchant.qpay.mn'),
  QPAY_QUICKQR_URL: url('https://quickqr.qpay.mn'),
  /** Merchant API HTTP Basic credentials (POST /v2/auth/token). */
  QPAY_USERNAME: opt,
  QPAY_PASSWORD: optRaw,
  /** Invoice code issued by QPay; defaults to `<QPAY_USERNAME>_INVOICE`. */
  QPAY_INVOICE_CODE: opt,
  /** Opaque secret embedded in the callback URL so only QPay can hit it. */
  QPAY_CALLBACK_TOKEN: opt,
  /** Origin QPay should call back on; defaults to PUBLIC_BASE_URL. */
  QPAY_CALLBACK_BASE_URL: opt
    .transform((v) => v?.replace(/\/+$/, ''))
    .pipe(z.string().url().optional()),

  /** Which API new invoices go through by default. */
  QPAY_DEFAULT_PROVIDER: z.enum(['quickqr', 'merchant']).default('quickqr'),

  /**
   * QuickQR (quickqr.qpay.mn). Authenticates with the same HTTP Basic credentials
   * as the merchant API *plus* a terminal_id in the body — verified against the
   * live host: Basic alone gives TERMINAL_ID_NOTFOUND, terminal_id alone gives
   * UnauthorizedError, both together return a token pair.
   */
  QPAY_QUICKQR_ENABLED: bool(false),
  QPAY_QUICKQR_TERMINAL_ID: opt,
  /** Optional overrides; default to QPAY_USERNAME / QPAY_PASSWORD. */
  QPAY_QUICKQR_USERNAME: opt,
  QPAY_QUICKQR_PASSWORD: optRaw,
  /** Sub-merchant invoices are issued against; created via POST /api/qpay/merchants/*. */
  QPAY_QUICKQR_MERCHANT_ID: opt,
  QPAY_QUICKQR_MCC_CODE: opt,
  /** Settlement account QuickQR invoices pay into. */
  QPAY_QUICKQR_BANK_CODE: opt,
  QPAY_QUICKQR_ACCOUNT_NUMBER: opt,
  QPAY_QUICKQR_ACCOUNT_NAME: opt,

  QPAY_HTTP_TIMEOUT_MS: int(15_000),
  /** Renew the access token this many seconds before it actually expires. */
  QPAY_TOKEN_SKEW_SECONDS: int(60),
  /** Key used to encrypt stored QPay tokens at rest; falls back to JWT_SECRET. */
  QPAY_TOKEN_SECRET: optRaw,
  /** How long a freshly created invoice stays payable, in minutes. */
  QPAY_INVOICE_TTL_MINUTES: int(30),

  TLS_ENABLED: bool(false),
  TLS_KEY_PATH: z.string().default('./certs/server.key'),
  TLS_CERT_PATH: z.string().default('./certs/server.crt'),
  TLS_CA_PATH: z.string().default('./certs/ca.crt'),

  CSMS_CA_KEY_PATH: z.string().default('./certs/ca.key'),
  CSMS_CA_CERT_PATH: z.string().default('./certs/ca.crt'),
  CSMS_CERT_VALIDITY_DAYS: int(365),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

/** Absolute public URL of a REST path, e.g. apiUrl('/charge-points'). */
export function apiUrl(subPath = ''): string {
  return `${env.PUBLIC_BASE_URL}${env.API_BASE_PATH}${subPath}`;
}

/** Absolute public WebSocket URL charge points connect to. */
export function ocppUrl(subPath = ''): string {
  return `${env.PUBLIC_BASE_URL.replace(/^http/, 'ws')}${env.OCPP_PATH_PREFIX}${subPath}`;
}

/** HTTP Basic header value for a QPay scope. */
export function qpayBasicAuth(scope: 'merchant' | 'quickqr'): string | null {
  const username =
    scope === 'quickqr' ? (env.QPAY_QUICKQR_USERNAME ?? env.QPAY_USERNAME) : env.QPAY_USERNAME;
  const password =
    scope === 'quickqr' ? (env.QPAY_QUICKQR_PASSWORD ?? env.QPAY_PASSWORD) : env.QPAY_PASSWORD;
  if (!username?.trim() || !password) return null;
  return Buffer.from(`${username.trim()}:${password}`, 'utf8').toString('base64');
}

/** Default settlement account for QuickQR invoices, when one is configured. */
export function qpayQuickQrBankAccount():
  | { account_bank_code: string; account_number: string; account_name: string; is_default: true }
  | undefined {
  const code = env.QPAY_QUICKQR_BANK_CODE?.trim();
  const number = env.QPAY_QUICKQR_ACCOUNT_NUMBER?.trim();
  const name = env.QPAY_QUICKQR_ACCOUNT_NAME?.trim();
  if (!code || !number || !name) return undefined;
  return { account_bank_code: code, account_number: number, account_name: name, is_default: true };
}

/** Base URL of the QPay merchant API for the configured mode. */
export function qpayMerchantBaseUrl(): string {
  return env.QPAY_MODE === 'production'
    ? env.QPAY_MERCHANT_PRODUCTION_URL
    : env.QPAY_MERCHANT_SANDBOX_URL;
}

/** Invoice code sent with every merchant invoice. */
export function qpayInvoiceCode(): string {
  return env.QPAY_INVOICE_CODE?.trim() || `${env.QPAY_USERNAME ?? ''}_INVOICE`;
}

/**
 * URL QPay calls when an invoice is paid. Both the optional static token and the
 * per-invoice secret sit in the path (never the query string, which QPay appends
 * its own parameters to). The handler still re-checks the payment with QPay
 * before trusting anything, so a leaked URL cannot fake a payment.
 */
export function qpayCallbackUrl(paymentId: string, secret: string): string {
  const origin = env.QPAY_CALLBACK_BASE_URL ?? env.PUBLIC_BASE_URL;
  const token = env.QPAY_CALLBACK_TOKEN?.trim();
  const prefix = token ? `/${encodeURIComponent(token)}` : '';
  return `${origin}${env.API_BASE_PATH}/payments/callback${prefix}/${paymentId}/${secret}`;
}

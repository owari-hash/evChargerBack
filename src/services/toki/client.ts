import QRCode from 'qrcode';
import { env, tokiBasicAuth } from '../../config/env';
import { requestToki, TokiError, tokiLogger } from './http';

interface CachedToken {
  accessToken: string;
  expiresAt: number; // unix ms
}

let tokenCache: CachedToken | null = null;

/**
 * Get or refresh the 14-day Toki Bearer access token using Basic Auth.
 */
export async function getAccessToken(forceRefresh = false): Promise<string> {
  const now = Date.now();
  // 1-hour skew buffer
  if (!forceRefresh && tokenCache && tokenCache.expiresAt > now + 3600_000) {
    return tokenCache.accessToken;
  }

  const basic = tokiBasicAuth();
  if (!basic) {
    throw new TokiError(503, 'Toki credentials (TOKI_USERNAME / TOKI_PASSWORD) are not configured');
  }

  tokiLogger.info('Requesting new Toki access token via Basic auth');
  const res = await requestToki<{ accessToken: string }>({
    path: '/third-party-service/v1/auth/token',
    method: 'GET',
    headers: {
      Authorization: `Basic ${basic}`,
    },
    label: 'GET /v1/auth/token',
  });

  if (!res.data?.accessToken) {
    throw new TokiError(500, 'Toki did not return an accessToken');
  }

  // Token valid for 14 days (14 * 24 * 3600 * 1000 ms)
  const ttlMs = 14 * 24 * 3600 * 1000;
  tokenCache = {
    accessToken: res.data.accessToken,
    expiresAt: now + ttlMs,
  };

  return tokenCache.accessToken;
}

export function clearTokenCache(): void {
  tokenCache = null;
}

/** Wrapper around requestToki that auto-injects Toki Bearer token and api-key header */
async function callTokiAuthorized<T = unknown>(req: {
  path: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  label?: string;
  retryOn401?: boolean;
}): Promise<T> {
  const token = await getAccessToken();
  const apiKey = env.TOKI_API_KEY || 'third_party_pay';

  try {
    const res = await requestToki<T>({
      path: req.path,
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
        'api-key': apiKey,
      },
      body: req.body,
      label: req.label,
    });
    return res.data;
  } catch (err) {
    if (err instanceof TokiError && err.status === 401 && req.retryOn401 !== false) {
      tokiLogger.warn('Toki token expired or invalid (401), refreshing token and retrying...');
      const freshToken = await getAccessToken(true);
      const res = await requestToki<T>({
        path: req.path,
        method: req.method,
        headers: {
          Authorization: `Bearer ${freshToken}`,
          'api-key': apiKey,
        },
        body: req.body,
        label: req.label,
      });
      return res.data;
    }
    throw err;
  }
}

export interface CreateMerchantQrInput {
  successUrl: string;
  failureUrl: string;
  orderId: string;
  amount: number;
  notes?: string;
  merchantId?: string;
}

export interface MerchantQrResult {
  requestId: string; // The EMV QR code text
  transactionId: string; // Toki transaction ID
  qrImage: string; // Generated base64 data URL PNG
}

/**
 * 2. Get Toki QR API (POST /third-party-service/v1/payment-request/merchant-qr)
 */
export async function createMerchantQr(input: CreateMerchantQrInput): Promise<MerchantQrResult> {
  const merchantId = input.merchantId || env.TOKI_MERCHANT_ID;
  if (!merchantId) throw new TokiError(503, 'TOKI_MERCHANT_ID is not configured');

  const data = await callTokiAuthorized<{ requestId: string; transactionId: string }>({
    path: '/third-party-service/v1/payment-request/merchant-qr',
    method: 'POST',
    body: {
      successUrl: input.successUrl,
      failureUrl: input.failureUrl,
      orderId: input.orderId,
      amount: input.amount,
      notes: input.notes || 'EV Charging',
      merchantId,
    },
    label: 'POST /v1/payment-request/merchant-qr',
  });

  const qrImage = await QRCode.toDataURL(data.requestId, {
    margin: 1,
    width: 320,
    color: {
      dark: '#000000',
      light: '#ffffff',
    },
  });

  return {
    requestId: data.requestId,
    transactionId: data.transactionId,
    qrImage,
  };
}

export interface CreatePhonePushInput {
  successUrl: string;
  failureUrl: string;
  orderId: string;
  phoneNo: string;
  amount: number;
  notes?: string;
  countryCode?: string;
  successText?: string;
  ebarimtText?: string;
  merchantId?: string;
}

/**
 * 3. Get Toki mobile request (Phone Push) (POST /third-party-service/v1/payment-request/phone-number)
 */
export async function createPhonePush(input: CreatePhonePushInput): Promise<{ requestId: string }> {
  const merchantId = input.merchantId || env.TOKI_MERCHANT_ID;
  if (!merchantId) throw new TokiError(503, 'TOKI_MERCHANT_ID is not configured');

  // Strip +976 or leading zero if present for clean phoneNo
  let phone = input.phoneNo.trim().replace(/^\+976/, '').replace(/^976/, '');
  if (phone.startsWith('0')) phone = phone.slice(1);

  const data = await callTokiAuthorized<{ requestId: string }>({
    path: '/third-party-service/v1/payment-request/phone-number',
    method: 'POST',
    body: {
      successUrl: input.successUrl,
      failureUrl: input.failureUrl,
      orderId: input.orderId,
      merchantId,
      amount: input.amount,
      notes: input.notes || 'EV Charging',
      phoneNo: phone,
      countryCode: input.countryCode || '+976',
      type: 'THIRD_PARTY_PAY',
      successText: input.successText,
      ebarimtText: input.ebarimtText,
    },
    label: 'POST /v1/payment-request/phone-number',
  });

  return data;
}

export interface CreateDeeplinkInput {
  successUrl: string;
  failureUrl: string;
  orderId: string;
  amount: number;
  notes?: string;
  merchantId?: string;
}

/**
 * 4. Get Toki deeplink request (POST /third-party-service/v1/payment-request/deeplink)
 */
export async function createDeeplink(
  input: CreateDeeplinkInput,
): Promise<{ deeplink: string; transactionId: string }> {
  const merchantId = input.merchantId || env.TOKI_MERCHANT_ID;
  if (!merchantId) throw new TokiError(503, 'TOKI_MERCHANT_ID is not configured');

  const data = await callTokiAuthorized<{ deeplink: string; transactionId: string }>({
    path: '/third-party-service/v1/payment-request/deeplink',
    method: 'POST',
    body: {
      successUrl: input.successUrl,
      failureUrl: input.failureUrl,
      orderId: input.orderId,
      merchantId,
      amount: input.amount,
      notes: input.notes || 'EV Charging',
      type: 'THIRD_PARTY_PAY',
    },
    label: 'POST /v1/payment-request/deeplink',
  });

  return data;
}

export interface TokiStatusResult {
  status: 'PENDING' | 'APPROVED' | 'EXPIRED' | 'CANCELLED';
  transNumber?: string;
  fee?: number;
  vatDetails?: {
    vatType?: string;
    vatId?: string;
  };
}

/**
 * 6. Check payment status (GET /third-party-service/v1/payment-request/status?requestId={{transactionId}})
 *
 * Can be called with either transactionId (from QR/deeplink) or requestId (from notify callback)
 */
export async function checkPaymentStatus(requestIdOrTxId: string): Promise<TokiStatusResult> {
  const data = await callTokiAuthorized<TokiStatusResult>({
    path: `/third-party-service/v1/payment-request/status?requestId=${encodeURIComponent(requestIdOrTxId)}`,
    method: 'GET',
    label: `GET /v1/payment-request/status`,
  });

  return data;
}

/**
 * 7. Cancel invoice (PATCH /third-party-service/v1/payment-request/{{requestId}})
 */
export async function cancelInvoice(requestId: string): Promise<void> {
  await callTokiAuthorized<Record<string, unknown>>({
    path: `/third-party-service/v1/payment-request/${encodeURIComponent(requestId)}`,
    method: 'PATCH',
    label: `PATCH /v1/payment-request/${requestId}`,
  });
}

export interface RefundInput {
  merchantId?: string;
  transNumber: string;
  amount?: number;
}

export interface RefundResult {
  transNumber: string;
  response: string;
  txnNumber?: string;
}

/**
 * 8. Refund payment (POST /third-party-service/v1/payment-request/refund)
 */
export async function refundPayment(input: RefundInput): Promise<RefundResult> {
  const merchantId = input.merchantId || env.TOKI_MERCHANT_ID;
  if (!merchantId) throw new TokiError(503, 'TOKI_MERCHANT_ID is not configured');

  const data = await callTokiAuthorized<RefundResult>({
    path: '/third-party-service/v1/payment-request/refund',
    method: 'POST',
    body: {
      merchantId,
      transNumber: input.transNumber,
      ...(input.amount !== undefined ? { amount: String(Math.round(input.amount)) } : {}),
    },
    label: 'POST /v1/payment-request/refund',
  });

  return data;
}

export interface RegisterVatInput {
  transactionId: string; // transNumber from check status
  DDTD: string;
  totalAmount?: number | string;
  vatAmount?: number | string;
  createdDate?: string; // MM/DD/YYYY
  merchantName?: string;
  merchantTin?: string;
}

/**
 * 9. Register Organization VAT details to Toki (POST /third-party-service/v1/payment-request/vat)
 */
export async function registerOrganizationVat(
  input: RegisterVatInput,
): Promise<{ status: string; message: string }> {
  const data = await callTokiAuthorized<{ status: string; message: string }>({
    path: '/third-party-service/v1/payment-request/vat',
    method: 'POST',
    body: {
      transactionId: input.transactionId,
      DDTD: input.DDTD,
      totalAmount: input.totalAmount !== undefined ? String(input.totalAmount) : '',
      vatAmount: input.vatAmount !== undefined ? String(input.vatAmount) : '',
      createdDate: input.createdDate || '',
      merchantName: input.merchantName || '',
      merchantTin: input.merchantTin || '',
    },
    label: 'POST /v1/payment-request/vat',
  });

  return data;
}

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';

/**
 * Golomt Bank e-commerce API (developer-hub.golomtbank.com, project 21).
 *
 * Every call is a JSON POST with the merchant's Bearer token, and every request
 * and response carries `checksum` = HMAC-SHA256(GOLOMT_SECRET_KEY, fields
 * concatenated), lowercase hex. The formulas, per the docs and checked against
 * the live host:
 *
 *   POST /api/invoice   req   transactionId + amount + returnType + callback
 *                       reply invoice + transactionId
 *   POST /api/inquiry   req   transactionId + transactionId
 *                       reply transactionId + errorCode + amount + token
 *   POST /api/pay       req   amount + transactionId + token
 *                       reply transactionId + errorCode + amount
 *   POST /api/check     req   transactionId + transactionId
 *                       reply transactionId + errorCode + amount + token
 *   push notification   body  transactionId + errorCode + amount + token
 *
 * A field that is absent or null contributes nothing to a reply checksum
 * (verified: a pending inquiry signs transactionId + amount alone).
 *
 * `errorCode` "000" is the only success; every other code is a decline.
 * Inquiry `status` is PENDING until the driver finishes on the bank page,
 * then SENT — with errorCode saying how it ended.
 *
 * Token payments (/api/pay, /api/check) must be switched on by the bank for
 * the merchant; until then they answer "Merchant is not allowed to do token
 * transaction", which is why they sit behind GOLOMT_TOKEN_ENABLED.
 */

export const golomtLogger = logger.child({ mod: 'golomt' });

export class GolomtError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GolomtError';
  }
}

export const GOLOMT_SUCCESS = '000';

function credentials(): { key: string; token: string } {
  const key = env.GOLOMT_SECRET_KEY;
  const token = env.GOLOMT_TOKEN?.trim();
  if (!env.GOLOMT_ENABLED || !key || !token) {
    throw new GolomtError(503, 'Golomt card payments are not configured');
  }
  return { key, token };
}

/** HMAC over the parts in order; null/undefined parts contribute nothing. */
export function checksum(...parts: (string | null | undefined)[]): string {
  return createHmac('sha256', credentials().key)
    .update(parts.map((p) => p ?? '').join(''))
    .digest('hex');
}

export function checksumMatches(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided.toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined;

async function post(path: string, body: Record<string, unknown>, label: string): Promise<Record<string, unknown>> {
  const { token } = credentials();
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${env.GOLOMT_BASE_URL.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(env.GOLOMT_HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    const e = err as Error;
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    golomtLogger.error({ label, err: e.message }, 'golomt request failed');
    throw new GolomtError(timedOut ? 504 : 502, timedOut ? 'Golomt did not respond' : 'Golomt is unreachable');
  }

  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text.slice(0, 300) };
  }

  if (!res.ok) {
    // Errors come as { timestamp, status, error, message, path }.
    const message = str(parsed.message) ?? str(parsed.error) ?? `Golomt returned HTTP ${res.status}`;
    golomtLogger.warn({ label, status: res.status, ms: Date.now() - started, body: parsed }, 'golomt error');
    // A rejected token or merchant setting is our configuration, never the driver's.
    throw new GolomtError(res.status === 401 || res.status === 403 ? 502 : res.status, message);
  }

  golomtLogger.debug({ label, ms: Date.now() - started }, 'golomt ok');
  return parsed;
}

// ---------------------------------------------------------------------------
// Hosted payment page
// ---------------------------------------------------------------------------

export interface GolomtInvoice {
  invoice: string;
  transactionId: string;
  socialDeeplink?: string;
}

/**
 * Opens a payment for `amount` tugrik. `transactionId` is ours: fewer than 16
 * letters/digits, unique per payment. The bank sends the browser back to
 * `callback` with GET once the driver is done on its page. With `genToken`,
 * a settled payment also yields a token for the card (when the bank has token
 * payments enabled for the merchant).
 */
export async function createInvoice(input: {
  transactionId: string;
  amount: number;
  callback: string;
  genToken?: boolean;
}): Promise<GolomtInvoice> {
  const amount = String(input.amount);
  const returnType = 'GET';
  const res = await post(
    '/api/invoice',
    {
      amount,
      callback: input.callback,
      checksum: checksum(input.transactionId, amount, returnType, input.callback),
      genToken: input.genToken ? 'Y' : 'N',
      returnType,
      transactionId: input.transactionId,
      // SocialPay is offered through QPay's QR flow, not the card page.
      socialDeeplink: 'N',
    },
    'createInvoice',
  );

  const invoice = str(res.invoice);
  if (!invoice || res.transactionId !== input.transactionId) {
    throw new GolomtError(502, 'Golomt returned no invoice');
  }
  if (!checksumMatches(checksum(invoice, input.transactionId), res.checksum)) {
    golomtLogger.error({ transactionId: input.transactionId }, 'golomt invoice checksum mismatch');
    throw new GolomtError(502, 'Golomt invoice failed verification');
  }
  return { invoice, transactionId: input.transactionId, socialDeeplink: str(res.socialDeeplink) };
}

/** The hosted page the driver is sent to. */
export function paymentPageUrl(invoice: string, kind: 'card' | 'socialpay' = 'card'): string {
  const base = env.GOLOMT_BASE_URL.replace(/\/+$/, '');
  return `${base}/${kind === 'socialpay' ? 'socialpay' : 'payment'}/${env.GOLOMT_PAGE_LANG}/${invoice}`;
}

// ---------------------------------------------------------------------------
// Results: inquiry, token check and push notifications share one shape
// ---------------------------------------------------------------------------

export interface GolomtResult {
  transactionId: string;
  /** Amount as the bank wrote it — the checksum is computed over this string. */
  amountText: string;
  amount: number;
  /** PENDING until the driver finishes on the bank page, then SENT. */
  status?: string;
  /** '000' on success; any other code is a decline; null while pending. */
  errorCode: string | null;
  errorDesc?: string;
  bank?: string;
  cardNumber?: string;
  cardHolder?: string;
  /** Only on a successful payment made with genToken = Y. */
  token?: string;
  /** True only when the bank's signature over the reply checked out. */
  verified: boolean;
}

/** Reads a signed result: transactionId + errorCode + amount + token. */
export function parseResult(transactionId: string, res: Record<string, unknown>): GolomtResult {
  const amountText = str(res.amount) ?? '';
  const errorCode = str(res.errorCode) ?? null;
  const token = str(res.token);
  return {
    transactionId,
    amountText,
    amount: Number(amountText) || 0,
    status: str(res.status)?.toUpperCase(),
    errorCode,
    errorDesc: str(res.errorDesc),
    bank: str(res.bank),
    cardNumber: str(res.cardNumber),
    cardHolder: str(res.cardHolder),
    token,
    verified: checksumMatches(checksum(transactionId, errorCode, amountText, token), res.checksum),
  };
}

/** The bank's verdict as one of ours. */
export function outcome(r: GolomtResult): 'PAID' | 'PENDING' | 'FAILED' {
  if (r.errorCode === GOLOMT_SUCCESS) return 'PAID';
  // A code other than success is a decline; without one the payment is open.
  if (r.errorCode) return 'FAILED';
  return 'PENDING';
}

/** Asks the bank how a hosted-page payment stands. */
export async function inquiry(transactionId: string): Promise<GolomtResult> {
  const res = await post(
    '/api/inquiry',
    { checksum: checksum(transactionId, transactionId), transactionId },
    'inquiry',
  );
  return parseResult(transactionId, res);
}

// ---------------------------------------------------------------------------
// Token (saved card) payments — need the bank to enable them for the merchant
// ---------------------------------------------------------------------------

/**
 * Charges a saved card with no page for the driver. The reply settles it
 * directly; `checkToken` re-reads it if the reply was lost.
 */
export async function payWithToken(input: {
  transactionId: string;
  amount: number;
  token: string;
}): Promise<GolomtResult> {
  const amount = String(input.amount);
  const res = await post(
    '/api/pay',
    {
      amount,
      checksum: checksum(amount, input.transactionId, input.token),
      transactionId: input.transactionId,
      lang: env.GOLOMT_PAGE_LANG === 'en' ? 'EN' : 'MN',
      token: input.token,
    },
    'pay',
  );
  // The pay reply signs transactionId + errorCode + amount — no token.
  const amountText = str(res.amount) ?? '';
  const errorCode = str(res.errorCode) ?? null;
  return {
    transactionId: input.transactionId,
    amountText,
    amount: Number(amountText) || 0,
    errorCode,
    errorDesc: str(res.errorDesc),
    cardNumber: str(res.cardNumber),
    verified: checksumMatches(checksum(input.transactionId, errorCode, amountText), res.checksum),
  };
}

/** Re-reads a token payment. Same signature as an inquiry. */
export async function checkToken(transactionId: string): Promise<GolomtResult> {
  const res = await post(
    '/api/check',
    { checksum: checksum(transactionId, transactionId), transactionId },
    'checkToken',
  );
  return parseResult(transactionId, res);
}

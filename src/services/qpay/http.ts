import { env } from '../../config/env';
import { logger } from '../../lib/logger';

export const qpayLogger = logger.child({ mod: 'qpay' });

/** An error returned by (or while talking to) the QPay API. */
export class QpayError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
    /** True when the token was rejected and a re-auth may fix it. */
    public readonly unauthorized = false,
  ) {
    super(message);
    this.name = 'QpayError';
  }
}

const SECRET_KEYS = new Set([
  'access_token',
  'refresh_token',
  'accesstoken',
  'refreshtoken',
  'password',
  'authorization',
  'api_key',
  'apikey',
  'x-api-key',
]);

/** Deep-copy a value with every credential-ish field replaced by '[redacted]'. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.has(k.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

export interface QpayRequest {
  baseUrl: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Label used in logs instead of the raw path (which may contain ids). */
  label?: string;
}


/**
 * QPay reports validation failures as an object keyed by field —
 * `{"invoice_id":{"type":"REQUIRED","message":"Required!"}}` — not as a string.
 * Interpolating that straight into an error message produced the useless
 * "QPay: [object Object]", which hid the actual cause. Flatten it to
 * `invoice_id: Required!` so both the log and the API response say what is wrong.
 */
function describeQpayError(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!value || typeof value !== 'object') return undefined;

  const parts: string[] = [];
  for (const [field, detail] of Object.entries(value as Record<string, unknown>)) {
    if (typeof detail === 'string') {
      parts.push(`${field}: ${detail}`);
    } else if (detail && typeof detail === 'object') {
      const d = detail as { message?: unknown; type?: unknown };
      const text = typeof d.message === 'string' ? d.message : String(d.type ?? '');
      parts.push(text ? `${field}: ${text}` : field);
    }
  }
  return parts.length > 0 ? parts.join('; ') : undefined;
}
/**
 * Single place every QPay HTTP call goes through: JSON in/out, a hard timeout,
 * consistent error mapping and logging that never prints tokens.
 */
export async function qpayFetch<T = unknown>(req: QpayRequest): Promise<T> {
  const url = `${req.baseUrl.replace(/\/+$/, '')}${req.path}`;
  const label = req.label ?? `${req.method} ${req.path}`;
  const started = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      method: req.method,
      headers: {
        Accept: 'application/json',
        ...(req.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...req.headers,
      },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(env.QPAY_HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    const e = err as Error;
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    qpayLogger.error({ label, err: e.message }, timedOut ? 'qpay request timed out' : 'qpay request failed');
    throw new QpayError(
      timedOut ? 504 : 502,
      timedOut ? `QPay did not respond within ${env.QPAY_HTTP_TIMEOUT_MS}ms` : `QPay is unreachable: ${e.message}`,
    );
  }

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }
  }

  const ms = Date.now() - started;

  if (!res.ok) {
    const body = parsed as { message?: unknown; error?: unknown; name?: unknown } | undefined;
    const message =
      describeQpayError(body?.message) ??
      describeQpayError(body?.error) ??
      describeQpayError(body?.name) ??
      `QPay returned HTTP ${res.status}`;
    qpayLogger.warn({ label, status: res.status, ms, body: redact(parsed) }, 'qpay error response');
    throw new QpayError(res.status, message, parsed, res.status === 401 || res.status === 403);
  }

  qpayLogger.debug({ label, status: res.status, ms }, 'qpay ok');
  return parsed as T;
}

/**
 * QPay reports expiry either as a duration in seconds or as an absolute UNIX
 * timestamp, depending on endpoint and environment. Anything above ~year 2001 in
 * epoch seconds is treated as absolute.
 */
export function resolveExpiry(value: unknown, fallbackSeconds: number): Date {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return new Date(Date.now() + fallbackSeconds * 1000);
  return n > 1_000_000_000 ? new Date(n * 1000) : new Date(Date.now() + n * 1000);
}

import { env, qpayBasicAuth, qpayMerchantBaseUrl } from '../../config/env';
import { QpayToken, type QpayTokenScope } from '../../models/QpayToken';
import { credentialFingerprint, decryptSecret, encryptSecret, tokenHint } from './crypto';
import { QpayError, qpayFetch, qpayLogger, resolveExpiry } from './http';

interface TokenResponse {
  token_type?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  refresh_expires_in?: number | string;
}

interface CachedToken {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date;
  refreshExpiresAt: Date | null;
  fingerprint: string;
  baseUrl: string;
}

interface ScopeConfig {
  baseUrl: string;
  fingerprint: string;
  /** Authenticate from scratch. */
  login(): Promise<TokenResponse>;
}

/** Access tokens live ~1h, refresh tokens ~a week. Used only if QPay omits them. */
const ACCESS_FALLBACK_SECONDS = 3_600;
const REFRESH_FALLBACK_SECONDS = 7 * 24 * 3_600;

const cache = new Map<QpayTokenScope, CachedToken>();
/** One in-flight auth per scope, so a burst of requests triggers a single login. */
const inFlight = new Map<QpayTokenScope, Promise<string>>();

function scopeConfig(scope: QpayTokenScope): ScopeConfig {
  if (scope === 'merchant') {
    const basic = qpayBasicAuth('merchant');
    if (!basic) throw new QpayError(500, 'QPAY_USERNAME / QPAY_PASSWORD are not configured');
    const baseUrl = qpayMerchantBaseUrl();
    return {
      baseUrl,
      fingerprint: credentialFingerprint('merchant', baseUrl, basic),
      login: () =>
        qpayFetch<TokenResponse>({
          baseUrl,
          method: 'POST',
          path: '/v2/auth/token',
          label: 'POST /v2/auth/token',
          headers: { Authorization: `Basic ${basic}` },
          // The credentials travel in the Basic header; QPay wants an empty JSON body.
          body: {},
        }),
    };
  }

  const terminalId = env.QPAY_QUICKQR_TERMINAL_ID?.trim();
  if (!terminalId) throw new QpayError(500, 'QPAY_QUICKQR_TERMINAL_ID is not configured');
  const basic = qpayBasicAuth('quickqr');
  if (!basic) throw new QpayError(500, 'QuickQR credentials are not configured');
  const baseUrl = env.QPAY_QUICKQR_URL;
  return {
    baseUrl,
    fingerprint: credentialFingerprint('quickqr', baseUrl, basic, terminalId),
    login: () =>
      qpayFetch<TokenResponse>({
        baseUrl,
        method: 'POST',
        path: '/v2/auth/token',
        label: 'POST /v2/auth/token (quickqr)',
        // QuickQR needs both halves: Basic identifies the integrator, terminal_id the POS.
        headers: { Authorization: `Basic ${basic}` },
        body: { terminal_id: terminalId },
      }),
  };
}

const skewMs = () => env.QPAY_TOKEN_SKEW_SECONDS * 1000;

const accessUsable = (t: CachedToken, fingerprint: string): boolean =>
  t.fingerprint === fingerprint && t.accessExpiresAt.getTime() - skewMs() > Date.now();

const refreshUsable = (t: CachedToken, fingerprint: string): boolean =>
  !!t.refreshToken &&
  t.fingerprint === fingerprint &&
  (!t.refreshExpiresAt || t.refreshExpiresAt.getTime() - skewMs() > Date.now());

async function loadFromDb(scope: QpayTokenScope): Promise<CachedToken | null> {
  const doc = await QpayToken.findById(scope).select('+accessToken +refreshToken').lean();
  if (!doc) return null;
  const accessToken = decryptSecret(doc.accessToken);
  if (!accessToken) {
    // Undecryptable (token secret rotated) — drop it instead of looping on failures.
    await QpayToken.deleteOne({ _id: scope });
    return null;
  }
  return {
    accessToken,
    refreshToken: decryptSecret(doc.refreshToken),
    accessExpiresAt: doc.accessExpiresAt,
    refreshExpiresAt: doc.refreshExpiresAt ?? null,
    fingerprint: doc.credentialFingerprint,
    baseUrl: doc.baseUrl,
  };
}

async function persist(scope: QpayTokenScope, token: CachedToken, refreshed: boolean): Promise<void> {
  await QpayToken.updateOne(
    { _id: scope },
    {
      $set: {
        accessToken: encryptSecret(token.accessToken),
        refreshToken: token.refreshToken ? encryptSecret(token.refreshToken) : undefined,
        accessExpiresAt: token.accessExpiresAt,
        refreshExpiresAt: token.refreshExpiresAt ?? undefined,
        credentialFingerprint: token.fingerprint,
        baseUrl: token.baseUrl,
        obtainedAt: new Date(),
      },
      ...(refreshed ? { $inc: { refreshCount: 1 } } : { $set: { refreshCount: 0 } }),
    },
    { upsert: true },
  ).catch((err: unknown) => {
    // A cache-write failure must not fail the caller's payment request.
    qpayLogger.warn({ scope, err: (err as Error).message }, 'could not persist qpay token');
  });
}

function toCached(res: TokenResponse, cfg: ScopeConfig): CachedToken {
  if (!res.access_token) throw new QpayError(502, 'QPay did not return an access_token', res);
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? null,
    accessExpiresAt: resolveExpiry(res.expires_in, ACCESS_FALLBACK_SECONDS),
    refreshExpiresAt: res.refresh_token
      ? resolveExpiry(res.refresh_expires_in, REFRESH_FALLBACK_SECONDS)
      : null,
    fingerprint: cfg.fingerprint,
    baseUrl: cfg.baseUrl,
  };
}

const refreshCall = (cfg: ScopeConfig, refreshToken: string) =>
  qpayFetch<TokenResponse>({
    baseUrl: cfg.baseUrl,
    method: 'POST',
    path: '/v2/auth/refresh',
    label: 'POST /v2/auth/refresh',
    headers: { Authorization: `Bearer ${refreshToken}` },
  });

async function acquire(scope: QpayTokenScope): Promise<string> {
  const cfg = scopeConfig(scope);
  const stored = cache.get(scope) ?? (await loadFromDb(scope));

  if (stored && accessUsable(stored, cfg.fingerprint)) {
    cache.set(scope, stored);
    return stored.accessToken;
  }

  if (stored?.refreshToken && refreshUsable(stored, cfg.fingerprint)) {
    try {
      const token = toCached(await refreshCall(cfg, stored.refreshToken), cfg);
      cache.set(scope, token);
      await persist(scope, token, true);
      qpayLogger.info(
        {
          scope,
          expiresAt: token.accessExpiresAt.toISOString(),
          token: tokenHint(token.accessToken),
        },
        'qpay access token refreshed',
      );
      return token.accessToken;
    } catch (err) {
      qpayLogger.warn(
        { scope, err: (err as Error).message },
        'qpay token refresh failed, falling back to a full login',
      );
    }
  }

  const token = toCached(await cfg.login(), cfg);
  cache.set(scope, token);
  await persist(scope, token, false);
  qpayLogger.info(
    { scope, expiresAt: token.accessExpiresAt.toISOString(), token: tokenHint(token.accessToken) },
    'qpay access token obtained',
  );
  return token.accessToken;
}

/** A valid access token for a scope, minting or refreshing one if needed. */
export async function getAccessToken(scope: QpayTokenScope): Promise<string> {
  const pending = inFlight.get(scope);
  if (pending) return pending;

  const promise = acquire(scope).finally(() => inFlight.delete(scope));
  inFlight.set(scope, promise);
  return promise;
}

/** Forget the cached token for a scope (called when QPay rejects it). */
export async function invalidateToken(scope: QpayTokenScope): Promise<void> {
  cache.delete(scope);
  await QpayToken.deleteOne({ _id: scope }).catch(() => undefined);
}

export interface AuthorizedRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  label?: string;
}

/**
 * Perform an authenticated QPay call, transparently re-authenticating once if the
 * token turns out to be dead on QPay's side (revoked, rotated, expired early).
 */
export async function authorizedFetch<T>(
  scope: QpayTokenScope,
  request: AuthorizedRequest,
): Promise<T> {
  const cfg = scopeConfig(scope);
  const call = (token: string) =>
    qpayFetch<T>({
      ...request,
      baseUrl: cfg.baseUrl,
      headers: { ...request.headers, Authorization: `Bearer ${token}` },
    });

  try {
    return await call(await getAccessToken(scope));
  } catch (err) {
    if (err instanceof QpayError && err.unauthorized) {
      qpayLogger.warn(
        { scope, label: request.label ?? request.path },
        'qpay rejected the token, re-authenticating once',
      );
      await invalidateToken(scope);
      return call(await getAccessToken(scope));
    }
    throw err;
  }
}

export interface TokenStatus {
  scope: QpayTokenScope;
  cached: boolean;
  accessExpiresAt?: string;
  refreshExpiresAt?: string;
  hasRefreshToken?: boolean;
}

/** Non-sensitive view of the cached token state, for the admin status endpoint. */
export function tokenStatus(scope: QpayTokenScope): TokenStatus {
  const t = cache.get(scope);
  return {
    scope,
    cached: !!t,
    accessExpiresAt: t?.accessExpiresAt.toISOString(),
    refreshExpiresAt: t?.refreshExpiresAt?.toISOString() ?? undefined,
    hasRefreshToken: t ? !!t.refreshToken : undefined,
  };
}

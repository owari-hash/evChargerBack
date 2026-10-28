import { env, tokiBaseUrl } from '../../config/env';
import { logger } from '../../lib/logger';

export const tokiLogger = logger.child({ mod: 'toki' });

export class TokiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'TokiError';
  }
}

export interface TokiRequest {
  path: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  label?: string;
}

export interface TokiEnvelope<T = unknown> {
  code: number;
  status: string;
  timestamp?: number;
  data: T;
  error?: { message?: string } | null;
}

export async function requestToki<T = unknown>(req: TokiRequest): Promise<TokiEnvelope<T>> {
  const method = req.method ?? 'GET';
  const url = `${tokiBaseUrl()}${req.path.startsWith('/') ? req.path : `/${req.path}`}`;
  const timeoutMs = env.TOKI_HTTP_TIMEOUT_MS;
  const label = req.label ?? `${method} ${req.path}`;

  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(req.body ? { 'content-type': 'application/json' } : {}),
    ...req.headers,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const start = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: req.body ? JSON.stringify(req.body) : undefined,
      signal: controller.signal,
    });
    const elapsed = Date.now() - start;

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }

    if (!res.ok) {
      const envelope = parsed as TokiEnvelope | undefined;
      const msg = envelope?.error?.message || (typeof parsed === 'string' ? parsed : `HTTP ${res.status}`);
      tokiLogger.warn({ label, status: res.status, elapsed, error: msg }, 'Toki API error response');
      throw new TokiError(res.status, `Toki: ${msg}`, parsed);
    }

    tokiLogger.debug({ label, status: res.status, elapsed }, 'Toki API success');
    return parsed as TokiEnvelope<T>;
  } catch (err) {
    if (err instanceof TokiError) throw err;
    const isTimeout = (err as Error).name === 'AbortError';
    tokiLogger.error({ label, err: (err as Error).message, isTimeout }, 'Toki HTTP request failed');
    throw new TokiError(isTimeout ? 504 : 502, isTimeout ? 'Toki request timed out' : `Toki connection failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

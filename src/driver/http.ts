import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { HttpError } from '../lib/errors';
import { apiLogger } from '../lib/logger';
import { CallTimeoutError, OcppRpcError } from '../ocpp/types';

/**
 * Request plumbing for the driver API.
 *
 * It keeps the envelope the kiosk's Next.js routes used — `{ error, fields? }`
 * with Mongolian messages — rather than the operator API's `{ error, details }`,
 * because the web app and the Flutter app already render exactly that.
 */

export const driverLogger = apiLogger.child({ area: 'driver' });

export class DriverError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'DriverError';
  }
}

export const unauthorized = (message = 'Үргэлжлүүлэхийн тулд нэвтэрнэ үү') =>
  new DriverError(401, message);
export const forbidden = (message = 'Танд энэ рүү хандах эрх байхгүй') =>
  new DriverError(403, message);
export const notFound = (message = 'Олдсонгүй') => new DriverError(404, message);
export const badRequest = (message: string, fields?: Record<string, string>) =>
  new DriverError(400, message, fields);
export const conflict = (message: string, fields?: Record<string, string>) =>
  new DriverError(409, message, fields);
export const tooMany = (message = 'Хэт олон хүсэлт илгээлээ. Дараа дахин оролдоно уу.') =>
  new DriverError(429, message);

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/** Flattens a ZodError into `{ field: firstMessage }` for form rendering. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.join('.') : '_form';
    out[key] ??= issue.message;
  }
  return out;
}

export function parseBody<S extends z.ZodTypeAny>(req: Request, schema: S): z.infer<S> {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) {
    throw new DriverError(400, 'Тэмдэглэсэн талбаруудаа шалгана уу', fieldErrors(result.error));
  }
  return result.data;
}

export function parseQuery<S extends z.ZodTypeAny>(req: Request, schema: S): z.infer<S> {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    throw new DriverError(400, 'Хайлтын утга буруу байна', fieldErrors(result.error));
  }
  return result.data;
}

/** An async handler whose resolved value goes back as a 200 JSON body. */
export function route(handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    handler(req, res).then((body) => {
      if (!res.headersSent) res.json(body);
    }, next);
  };
}

// ---------------------------------------------------------------------------
// Rate limiting — an in-memory fixed window per scope and client address. Good
// enough for the single CSMS process; it needs a shared store if that scales out.
// ---------------------------------------------------------------------------

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}, MINUTE).unref();

/** Throws 429 when the caller exceeds `limit` requests per `windowMs` for `scope`. */
export function guard(req: Request, scope: string, limit: number, windowMs: number): void {
  // `trust proxy` is on, so behind nginx this is the driver's address.
  const key = `${scope}:${req.ip ?? 'unknown'}`;
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    const seconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    throw tooMany(`Хэт олон удаа оролдлоо. ${seconds} секундын дараа дахин оролдоно уу.`);
  }
}

export const driverErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof DriverError) {
    res
      .status(err.status)
      .json({ error: err.message, ...(err.fields ? { fields: err.fields } : {}) });
    return;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: 'Тэмдэглэсэн талбаруудаа шалгана уу', fields: fieldErrors(err) });
    return;
  }
  if ((err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: 'JSON форматтай хүсэлтийн бие шаардлагатай' });
    return;
  }
  // Raised by the CSMS services this API calls into. A 401 there would be the
  // CSMS refusing us, not the driver, so it must not sign the driver out.
  if (err instanceof HttpError) {
    res.status(err.status === 401 ? 502 : err.status).json({ error: err.message });
    return;
  }
  if (err instanceof CallTimeoutError) {
    res.status(504).json({ error: 'Станц хугацаандаа хариу өгсөнгүй. Дахин оролдоно уу.' });
    return;
  }
  if (err instanceof OcppRpcError) {
    res.status(502).json({ error: 'Станц хүсэлтийг гүйцэтгэж чадсангүй. Дахин оролдоно уу.' });
    return;
  }

  driverLogger.error({ err }, 'unhandled driver API error');
  res.status(500).json({ error: 'Манай талд алдаа гарлаа' });
};

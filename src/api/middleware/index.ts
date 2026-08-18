import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { apiLogger } from '../../lib/logger';
import { HttpError } from '../../lib/errors';
import { CallTimeoutError, OcppRpcError } from '../../ocpp/types';

export * from './auth';

/** Wrap an async route so rejected promises reach the error handler. */
export function asyncHandler<T extends RequestHandler>(fn: T): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}

type Source = 'body' | 'query' | 'params';

/** Validate part of the request against a zod schema, replacing it with the parsed value. */
export function validate(schema: z.ZodTypeAny, source: Source = 'body'): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(new HttpError(400, 'Validation failed', result.error.flatten()));
      return;
    }
    // req.query / req.params are getters in Express 5; assign defensively.
    Object.defineProperty(req, source, { value: result.data, writable: true, configurable: true });
    next();
  };
}

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  sort: z.string().optional(),
});

export type Pagination = z.infer<typeof paginationSchema>;

export function paginate(p: Pagination) {
  return { skip: (p.page - 1) * p.limit, limit: p.limit };
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details ?? undefined });
    return;
  }
  if (err instanceof CallTimeoutError) {
    res.status(504).json({ error: err.message });
    return;
  }
  if (err instanceof OcppRpcError) {
    res.status(502).json({
      error: 'The charge point returned an OCPP error',
      code: err.code,
      description: err.message,
      details: err.details,
    });
    return;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: 'Validation failed', details: err.flatten() });
    return;
  }

  const e = err as Error & { code?: number | string; keyPattern?: unknown };
  if (e?.code === 11000) {
    res.status(409).json({ error: 'Duplicate key', details: e.keyPattern });
    return;
  }
  if (e?.name === 'ValidationError' || e?.name === 'CastError') {
    res.status(400).json({ error: e.message });
    return;
  }

  apiLogger.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'Internal server error' });
}

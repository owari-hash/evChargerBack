import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { forbidden, unauthorized } from '../../lib/errors';
import type { UserRole } from '../../models/enums';

export interface AuthPrincipal {
  id: string;
  email: string;
  role: UserRole;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthPrincipal;
  }
}

export function signToken(principal: AuthPrincipal): string {
  return jwt.sign(principal, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  } as jwt.SignOptions);
}

/** Accepts either `Authorization: Bearer <jwt>` or `x-api-key: <API_KEY>`. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const apiKey = req.header('x-api-key');
  if (env.API_KEY && apiKey && apiKey === env.API_KEY) {
    req.user = { id: 'api-key', email: 'api-key', role: 'ADMIN' };
    next();
    return;
  }

  const header = req.header('authorization');
  if (!header?.toLowerCase().startsWith('bearer ')) {
    next(unauthorized('Missing bearer token'));
    return;
  }

  try {
    const decoded = jwt.verify(header.slice(7).trim(), env.JWT_SECRET) as AuthPrincipal;
    req.user = { id: decoded.id, email: decoded.email, role: decoded.role };
    next();
  } catch {
    next(unauthorized('Invalid or expired token'));
  }
}

const RANK: Record<UserRole, number> = { VIEWER: 0, OPERATOR: 1, ADMIN: 2 };

export function requireRole(min: UserRole) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(unauthorized());
      return;
    }
    if (RANK[req.user.role] < RANK[min]) {
      next(forbidden(`Requires ${min} role or higher`));
      return;
    }
    next();
  };
}

export const requireOperator = requireRole('OPERATOR');
export const requireAdmin = requireRole('ADMIN');

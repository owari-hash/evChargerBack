import type { CookieOptions, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { isProduction, sessionSecret } from '../config';
import { driverLogger, unauthorized } from '../http';
import { store, type StoredUser } from '../store';
import type { PublicUser } from '../types';

/**
 * The driver session: an HS256 JWT in the httpOnly `evapp_session` cookie.
 *
 * The token format is unchanged from the kiosk web app (`sub` = account id,
 * `v` = tokenVersion), so cookies it issued keep validating here.
 */

interface SessionClaims {
  sub: string;
  /** Must match the account's tokenVersion, so a PIN reset logs out old devices. */
  v: number;
}

const DAY_SECONDS = 24 * 60 * 60;

function createSessionToken(user: StoredUser): string {
  return jwt.sign({ v: user.tokenVersion }, sessionSecret(), {
    algorithm: 'HS256',
    subject: user.id,
    expiresIn: env.SESSION_MAX_AGE_DAYS * DAY_SECONDS,
  });
}

function verifySessionToken(token: string): SessionClaims | null {
  try {
    const payload = jwt.verify(token, sessionSecret(), { algorithms: ['HS256'] });
    if (typeof payload === 'string' || !payload.sub) return null;
    return { sub: payload.sub, v: Number((payload as { v?: unknown }).v ?? 0) };
  } catch {
    return null;
  }
}

const cookieOptions = (): CookieOptions => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: isProduction,
  path: '/',
});

export function setSessionCookie(res: Response, user: StoredUser): void {
  res.cookie(env.SESSION_COOKIE_NAME, createSessionToken(user), {
    ...cookieOptions(),
    maxAge: env.SESSION_MAX_AGE_DAYS * DAY_SECONDS * 1000,
  });
}

export function clearSessionCookie(res: Response): void {
  res.cookie(env.SESSION_COOKIE_NAME, '', { ...cookieOptions(), maxAge: 0 });
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

// A handler may ask more than once; the account is loaded once per request.
const resolved = new WeakMap<Request, Promise<StoredUser | null>>();

/** The signed-in account, or null. */
export function getCurrentUser(req: Request): Promise<StoredUser | null> {
  let pending = resolved.get(req);
  if (!pending) {
    pending = loadUser(req);
    resolved.set(req, pending);
  }
  return pending;
}

async function loadUser(req: Request): Promise<StoredUser | null> {
  const token = readCookie(req, env.SESSION_COOKIE_NAME);
  if (!token) return null;

  const claims = verifySessionToken(token);
  if (!claims) return null;

  try {
    const user = await store.findUserById(claims.sub);
    if (!user || !user.isActive) return null;
    if ((user.tokenVersion ?? 0) !== claims.v) return null;
    return user;
  } catch (err) {
    driverLogger.error({ err }, 'failed to load the signed-in driver');
    return null;
  }
}

export async function requireUser(req: Request): Promise<StoredUser> {
  const user = await getCurrentUser(req);
  if (!user) throw unauthorized();
  return user;
}

export function toPublicUser(user: StoredUser): PublicUser {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    name: user.name,
    emailVerified: Boolean(user.emailVerifiedAt),
    phoneVerified: Boolean(user.phoneVerifiedAt),
    hasPin: Boolean(user.pinHash),
    idTag: user.idTag,
    vehicleBrand: user.vehicleBrand,
    vehicleModel: user.vehicleModel,
    pendingGuides: user.pendingGuides ?? [],
    locale: user.locale ?? 'en',
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

import type { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { forbidden, unauthorized } from '../../lib/errors';
import { PartnerMerchant, type PartnerMerchantDoc, type PartnerScope } from '../../models/PartnerMerchant';
import { PartnerRefreshToken } from '../../models/PartnerRefreshToken';
import { PartnerApiLog } from '../../models/PartnerApiLog';

export interface PartnerTokenPayload {
  sub: string;
  type: 'partner_access';
  merchantId: string;
  username: string;
  name: string;
  scopes: string[];
  tokenVersion: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    partnerMerchant?: PartnerMerchantDoc;
  }
}

const ACCESS_TOKEN_EXPIRES_IN = '2h';
const REFRESH_TOKEN_DAYS = 30;

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Signs a short-lived access JWT for a partner merchant
 */
export function signPartnerAccessToken(merchant: PartnerMerchantDoc): string {
  const payload: PartnerTokenPayload = {
    sub: String(merchant._id),
    type: 'partner_access',
    merchantId: String(merchant._id),
    username: merchant.username,
    name: merchant.name,
    scopes: merchant.allowedScopes || [],
    tokenVersion: merchant.tokenVersion || 0,
  };

  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRES_IN,
  } as jwt.SignOptions);
}

/**
 * Creates a persistent refresh token for partner merchant
 */
export async function createPartnerRefreshToken(
  merchantId: string,
  ip?: string,
  userAgent?: string,
  family?: string,
): Promise<string> {
  const rawToken = crypto.randomBytes(40).toString('hex');
  const tokenHash = hashToken(rawToken);
  const tokenFamily = family || crypto.randomUUID();

  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);

  await PartnerRefreshToken.create({
    merchantId,
    tokenHash,
    family: tokenFamily,
    expiresAt,
    isRevoked: false,
    createdByIp: ip,
    userAgent,
  });

  return rawToken;
}

/**
 * Authenticates partner and issues both access and refresh tokens
 */
export async function issuePartnerTokens(
  merchant: PartnerMerchantDoc,
  ip?: string,
  userAgent?: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  merchant: {
    id: string;
    name: string;
    code: string;
    username: string;
    scopes: string[];
    allowedStations: string[];
  };
}> {
  const accessToken = signPartnerAccessToken(merchant);
  const refreshToken = await createPartnerRefreshToken(String(merchant._id), ip, userAgent);

  return {
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: 7200, // 2 hours in seconds
    merchant: {
      id: String(merchant._id),
      name: merchant.name,
      code: merchant.code,
      username: merchant.username,
      scopes: merchant.allowedScopes || [],
      allowedStations: merchant.allowedStations || [],
    },
  };
}

/**
 * Validates a refresh token, revokes it, and issues rotated new tokens
 */
export async function rotatePartnerRefreshToken(
  rawRefreshToken: string,
  ip?: string,
  userAgent?: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}> {
  const tokenHash = hashToken(rawRefreshToken);
  const existing = await PartnerRefreshToken.findOne({ tokenHash });

  if (!existing || existing.isRevoked || existing.expiresAt < new Date()) {
    // If revoked token was reused, revoke entire family as security breach
    if (existing?.isRevoked) {
      await PartnerRefreshToken.updateMany({ family: existing.family }, { $set: { isRevoked: true } });
    }
    throw unauthorized('Хүчингүй эсвэл хугацаа нь дууссан сэргээх токен');
  }

  // Revoke old token
  existing.isRevoked = true;
  await existing.save();

  const merchant = await PartnerMerchant.findById(existing.merchantId);
  if (!merchant || !merchant.isActive) {
    throw forbidden('Мерчант бүртгэл идэвхгүй болсон байна');
  }

  const accessToken = signPartnerAccessToken(merchant);
  const newRefreshToken = await createPartnerRefreshToken(String(merchant._id), ip, userAgent, existing.family);

  return {
    accessToken,
    refreshToken: newRefreshToken,
    tokenType: 'Bearer',
    expiresIn: 7200,
  };
}

/**
 * Revokes all tokens for a partner merchant
 */
export async function revokeAllPartnerTokens(merchantId: string): Promise<void> {
  await PartnerRefreshToken.updateMany({ merchantId }, { $set: { isRevoked: true } });
  await PartnerMerchant.findByIdAndUpdate(merchantId, { $inc: { tokenVersion: 1 } });
}

/**
 * Express middleware to authenticate partner merchant requests
 * Also logs all API calls to PartnerApiLog for monitoring and control
 */
export async function requirePartnerAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.header('authorization');
  if (!header?.toLowerCase().startsWith('bearer ')) {
    next(unauthorized('Bearer токен дутуу байна (Authorization: Bearer <token>)'));
    return;
  }

  const token = header.slice(7).trim();
  let decoded: PartnerTokenPayload;

  try {
    decoded = jwt.verify(token, env.JWT_SECRET) as PartnerTokenPayload;
  } catch {
    next(unauthorized('Токен хүчингүй эсвэл хугацаа нь дууссан байна'));
    return;
  }

  if (decoded.type !== 'partner_access' || !decoded.merchantId) {
    next(unauthorized('Мерчант токен биш байна'));
    return;
  }

  try {
    const merchant = await PartnerMerchant.findById(decoded.merchantId);
    if (!merchant) {
      next(unauthorized('Мерчант олдсонгүй'));
      return;
    }

    if (!merchant.isActive) {
      next(forbidden('Мерчантын API эрх хаагдсан байна. Админтай холбогдоно уу'));
      return;
    }

    if ((decoded.tokenVersion || 0) !== (merchant.tokenVersion || 0)) {
      next(unauthorized('Токен цуцлагдсан байна. Дахин нэвтэрнэ үү'));
      return;
    }

    // IP Whitelist check if configured
    const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '';
    if (merchant.ipWhitelist && merchant.ipWhitelist.length > 0) {
      const allowed = merchant.ipWhitelist.some((ip) => ip.trim() === clientIp || clientIp.startsWith(ip.trim()));
      if (!allowed) {
        next(forbidden(`Зөвшөөрөгдөөгүй IP хаяг: ${clientIp}`));
        return;
      }
    }

    req.partnerMerchant = merchant;

    // Monitor and log API calls
    const startTime = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - startTime;
      const sanitizedBody = req.body ? { ...req.body } : undefined;
      if (sanitizedBody && 'password' in sanitizedBody) sanitizedBody.password = '[REDACTED]';

      PartnerApiLog.create({
        merchantId: merchant._id,
        merchantName: merchant.name,
        merchantUsername: merchant.username,
        method: req.method,
        endpoint: req.originalUrl || req.url,
        statusCode: res.statusCode,
        durationMs,
        ip: clientIp,
        userAgent: req.header('user-agent') || '',
        requestQuery: Object.keys(req.query || {}).length ? req.query : undefined,
        requestBody: sanitizedBody,
        errorMessage: res.locals.errorMessage || (res.statusCode >= 400 ? `HTTP ${res.statusCode}` : undefined),
      }).catch(() => {});

      // Update merchant telemetry
      PartnerMerchant.findByIdAndUpdate(merchant._id, {
        $inc: { totalApiCalls: 1 },
        $set: { lastActiveAt: new Date() },
      }).catch(() => {});
    });

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware to enforce required scope
 */
export function requirePartnerScope(scope: PartnerScope) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const merchant = req.partnerMerchant;
    if (!merchant) {
      next(unauthorized());
      return;
    }

    const scopes = merchant.allowedScopes || [];
    if (!scopes.includes(scope) && !scopes.includes('*' as any)) {
      next(forbidden(`Энэ үйлдлийг хийх "${scope}" эрх олгогдоогүй байна`));
      return;
    }

    next();
  };
}


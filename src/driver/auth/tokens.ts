import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** Opaque link secret used in email-verification URLs. */
export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** 6-digit numeric one-time code for SMS delivery. */
export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function secretMatches(secret: string, expectedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Link tokens carry the record id so the lookup is a single indexed read:
 * `<tokenId>.<secret>`.
 */
export function composeLinkToken(tokenId: string, secret: string): string {
  return `${tokenId}.${secret}`;
}

export function parseLinkToken(token: string): { id: string; secret: string } | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  return { id: token.slice(0, dot), secret: token.slice(dot + 1) };
}

export const TOKEN_TTL_MINUTES = {
  password_reset: 30,
  email_verify: 60 * 24,
  phone_verify: 10,
} as const;

export function expiryFor(kind: keyof typeof TOKEN_TTL_MINUTES): Date {
  return new Date(Date.now() + TOKEN_TTL_MINUTES[kind] * 60_000);
}

/** j***@example.com / ********1234 — shown after a code is sent. */
export function maskDestination(value: string, channel: 'email' | 'sms'): string {
  if (channel === 'email') {
    const [local = '', domain = ''] = value.split('@');
    const head = local.slice(0, 1) || '*';
    return `${head}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
  }
  const tail = value.slice(-4);
  return `${'*'.repeat(Math.max(0, value.length - 4))}${tail}`;
}

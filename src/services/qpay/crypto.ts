import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../../config/env';

/**
 * QPay access/refresh tokens are bearer credentials for money movement, so they
 * are encrypted before they touch the database. AES-256-GCM with a key derived
 * from QPAY_TOKEN_SECRET (or JWT_SECRET as a fallback) gives us confidentiality
 * plus tamper detection — a modified ciphertext fails to decrypt instead of
 * silently yielding garbage.
 */
const VERSION = 'v1';

function key(): Buffer {
  const secret = env.QPAY_TOKEN_SECRET?.trim() || env.JWT_SECRET;
  return createHash('sha256').update(`qpay-token:${secret}`).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(
    ':',
  );
}

/** Returns null when the value is unreadable (wrong key, corrupted, legacy format). */
export function decryptSecret(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    return null;
  }
}

/**
 * Stable, non-reversible fingerprint of the credentials a token was minted with.
 * Stored beside the token so rotating credentials invalidates cached tokens.
 */
export function credentialFingerprint(...parts: (string | undefined)[]): string {
  return createHash('sha256').update(parts.map((p) => p ?? '').join('\u0000')).digest('hex').slice(0, 16);
}

/** Last 4 characters only — safe to log when diagnosing token problems. */
export function tokenHint(token: string | null | undefined): string {
  if (!token) return 'none';
  return `…${token.slice(-4)} (len ${token.length})`;
}

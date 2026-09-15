import { env } from '../config/env';

export const isProduction = env.NODE_ENV === 'production';

/**
 * Signs session cookies and sign-up / PIN-reset tickets.
 *
 * The kiosk web app signed them with SESSION_SECRET before the API moved here.
 * Copying that value across is what keeps every driver signed in through the
 * move; a different value signs everyone out once.
 */
export function sessionSecret(): string {
  const secret = env.SESSION_SECRET ?? '';
  if (secret.length >= 32) return secret;
  if (isProduction) {
    throw new Error('SESSION_SECRET must be set to at least 32 characters in production');
  }
  return 'dev-only-insecure-session-secret-change-me';
}

/** Dev convenience: SMS codes and email links come back in the API response. */
export const devExposeTokens = (): boolean => !isProduction && env.DEV_EXPOSE_TOKENS;

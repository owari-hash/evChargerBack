import { DriverError, driverLogger, HOUR, tooMany } from '../http';
import { sendSms } from '../notify';
import { store, type StoredToken } from '../store';
import { expiryFor, generateOtp, hashSecret, secretMatches, TOKEN_TTL_MINUTES } from './tokens';

const MAX_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

/** Kinds whose codes go out by SMS in the sign-up and PIN reset flows. */
type SmsKind = 'phone_verify' | 'password_reset';

/**
 * Codes are filed under an owner key. For an existing account that is its id;
 * before an account exists it is derived from the number being registered.
 */
export function signupOwner(phone: string): string {
  return `signup:${phone}`;
}

/** Texts a fresh 6-digit code, retiring any earlier one. Returns the code. */
export async function sendSmsCode(input: {
  owner: string;
  kind: SmsKind;
  destination: string;
  text: (code: string, minutes: number) => string;
}): Promise<string> {
  const issued = await store.countTokensSince(input.owner, input.kind, new Date(Date.now() - HOUR));
  if (issued >= MAX_PER_HOUR) {
    throw tooMany('Хэт олон код хүсэлээ. Нэг цагийн дараа дахин оролдоно уу.');
  }

  await store.invalidateTokens(input.owner, input.kind);

  const code = generateOtp();
  await store.createToken({
    userId: input.owner,
    kind: input.kind,
    secretHash: hashSecret(code),
    channel: 'sms',
    destination: input.destination,
    expiresAt: expiryFor(input.kind),
  });

  const delivery = await sendSms({
    to: input.destination,
    text: input.text(code, TOKEN_TTL_MINUTES[input.kind]),
  });
  if (!delivery.delivered) {
    driverLogger.error({ error: delivery.error }, 'sms code not delivered');
    throw new DriverError(502, 'Одоохондоо кодыг илгээж чадсангүй. Хэсэг хугацааны дараа дахин оролдоно уу.');
  }
  return code;
}

function usable(token: StoredToken): boolean {
  if (token.usedAt) return false;
  if (token.attempts >= MAX_ATTEMPTS) return false;
  return new Date(token.expiresAt).getTime() > Date.now();
}

/**
 * Checks a code and burns it on success. Each wrong guess costs the outstanding
 * codes an attempt, so a code cannot be brute-forced within its lifetime.
 */
export async function consumeSmsCode(owner: string, kind: SmsKind, code: string): Promise<boolean> {
  const candidates = (await store.findActiveTokens(owner, kind)).filter(
    (token) => token.channel === 'sms' && usable(token),
  );

  for (const candidate of candidates) {
    if (secretMatches(code, candidate.secretHash)) {
      await store.invalidateTokens(owner, kind);
      return true;
    }
    const attempts = await store.incrementTokenAttempts(candidate.id);
    if (attempts >= MAX_ATTEMPTS) await store.markTokenUsed(candidate.id);
  }
  return false;
}

export const invalidCode = () =>
  new DriverError(400, 'Энэ код буруу эсвэл хугацаа нь дууссан байна. Шинэ код авна уу.', {
    code: 'Энэ код буруу байна',
  });

export const phoneTaken = () =>
  new DriverError(409, 'Энэ утасны дугаар аль хэдийн бүртгэлтэй байна. Нэвтэрнэ үү.', {
    phone: 'Энэ утасны дугаар аль хэдийн бүртгэлтэй байна',
  });

/** The `ticket` field tells clients to send the driver back to the first step. */
export const expiredTicket = () =>
  new DriverError(400, 'Баталгаажуулалтын хугацаа дууссан байна. Утасны дугаараа дахин оруулна уу.', {
    ticket: 'Хугацаа дууссан',
  });

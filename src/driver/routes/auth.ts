import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { issuePhoneTicket, readPhoneTicket } from '../auth/phone-ticket';
import {
  clearedPinLock,
  dummyPinHash,
  failedPinPatch,
  hashPin,
  pinLock,
  pinLockMessage,
  verifyPin,
} from '../auth/pin';
import { clearSessionCookie, requireUser, setSessionCookie, toPublicUser } from '../auth/session';
import {
  consumeSmsCode,
  expiredTicket,
  invalidCode,
  phoneTaken,
  sendSmsCode,
  signupOwner,
} from '../auth/sms-code';
import {
  composeLinkToken,
  expiryFor,
  generateOtp,
  generateSecret,
  hashSecret,
  maskDestination,
  parseLinkToken,
  secretMatches,
  TOKEN_TTL_MINUTES,
} from '../auth/tokens';
import { ensureChargeTag } from '../charge-tag';
import { devExposeTokens } from '../config';
import {
  badRequest,
  conflict,
  DriverError,
  driverLogger,
  guard,
  HOUR,
  MINUTE,
  notFound,
  parseBody,
  route,
  tooMany,
  unauthorized,
} from '../http';
import { sendEmail, sendSms, templates } from '../notify';
import { store, type StoredToken, type StoredUser } from '../store';
import {
  loginSchema,
  normalizePhone,
  phoneCodeSchema,
  pinForgotSchema,
  pinResetSchema,
  signupCompleteSchema,
  signupSendCodeSchema,
  guestSendCodeSchema,
  guestLoginSchema,
  verifyPhoneSchema,
} from '../validation';

/**
 * Phone + PIN sign-in, three-step sign-up and PIN reset, and verifying a new
 * phone number or email on an existing account.
 */
export const authRoutes = Router();

/** Codes and links echoed back in development so flows can be tested without SMS. */
const devOnly = (extra: Record<string, string>) => (devExposeTokens() ? extra : {});

const MAX_CODE_ATTEMPTS = 5;

function usableCode(token: StoredToken): boolean {
  if (token.usedAt) return false;
  if (token.attempts >= MAX_CODE_ATTEMPTS) return false;
  return new Date(token.expiresAt).getTime() > Date.now();
}

const smsNotDelivered = () =>
  new DriverError(502, 'Одоохондоо кодыг илгээж чадсангүй. Хэсэг хугацааны дараа дахин оролдоно уу.');

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const WRONG_CREDENTIALS = 'Утасны дугаар эсвэл PIN код буруу байна';

authRoutes.post(
  '/login',
  route(async (req, res) => {
    guard(req, 'auth:login', 10, 15 * MINUTE);
    // The schema has already normalised the number to E.164.
    const { phone, pin } = parseBody(req, loginSchema);

    const user = await store.findUserByPhone(phone);

    // Inactive accounts get the same wording so the endpoint reveals nothing.
    if (!user || !user.isActive) {
      await verifyPin(pin, await dummyPinHash());
      throw unauthorized(WRONG_CREDENTIALS);
    }

    const lock = pinLock(user);
    if (lock.kind !== 'none') throw tooMany(pinLockMessage(lock));

    // An account from before PIN sign-in: the SMS reset is how it gets one.
    if (!user.pinHash) {
      throw new DriverError(
        401,
        'Энэ бүртгэлд PIN код тохируулаагүй байна. «PIN код мартсан» дээр дарж SMS кодоор тохируулна уу.',
        { pin: 'PIN код тохируулаагүй байна' },
      );
    }

    if (!(await verifyPin(pin, user.pinHash))) {
      const failed = (await store.updateUser(user.id, failedPinPatch(user))) ?? user;
      const now = pinLock(failed);
      if (now.kind !== 'none') throw tooMany(pinLockMessage(now));
      throw unauthorized(WRONG_CREDENTIALS);
    }

    const updated =
      (await store.updateUser(user.id, {
        ...clearedPinLock,
        lastLoginAt: new Date().toISOString(),
      })) ?? user;

    setSessionCookie(res, updated);
    return { user: toPublicUser(updated) };
  }),
);

authRoutes.post(
  '/logout',
  route(async (_req, res) => {
    clearSessionCookie(res);
    return { ok: true };
  }),
);

authRoutes.get(
  '/me',
  route(async (req) => {
    let user = await requireUser(req);
    // An account whose tag could not be issued at sign-up gets it here, the way
    // the web app's account page used to issue it.
    if (!user.idTag) {
      const idTag = await ensureChargeTag(user);
      if (idTag) user = { ...user, idTag };
    }
    return { user: toPublicUser(user) };
  }),
);

// ---------------------------------------------------------------------------
// Sign-up: send code → verify code (ticket) → complete with a PIN
// ---------------------------------------------------------------------------

authRoutes.post(
  '/signup/send-code',
  route(async (req) => {
    guard(req, 'auth:signup-send-code', 10, HOUR);
    const { phone } = parseBody(req, signupSendCodeSchema);

    if (await store.findUserByPhone(phone)) throw phoneTaken();

    const code = await sendSmsCode({
      owner: signupOwner(phone),
      kind: 'phone_verify',
      destination: phone,
      text: templates.signupSms,
    });

    return { ok: true, destination: maskDestination(phone, 'sms'), ...devOnly({ devCode: code }) };
  }),
);

/** Nothing is created yet; the ticket returned here is what step 3 exchanges for an account. */
authRoutes.post(
  '/signup/verify',
  route(async (req) => {
    guard(req, 'auth:signup-verify', 20, HOUR);
    const { phone, code } = parseBody(req, phoneCodeSchema);

    if (await store.findUserByPhone(phone)) throw phoneTaken();
    if (!(await consumeSmsCode(signupOwner(phone), 'phone_verify', code))) throw invalidCode();

    return { ok: true, signupTicket: issuePhoneTicket('signup', { phone }) };
  }),
);

authRoutes.post(
  '/signup/complete',
  route(async (req, res) => {
    guard(req, 'auth:signup-complete', 10, HOUR);
    const body = parseBody(req, signupCompleteSchema);

    const ticket = readPhoneTicket('signup', body.signupTicket);
    if (!ticket) throw expiredTicket();

    if (await store.findUserByPhone(ticket.phone)) throw phoneTaken();

    let user: StoredUser;
    try {
      user = await store.createUser({
        phone: ticket.phone,
        // The ticket is the proof: it is only issued for a code that came back.
        phoneVerifiedAt: new Date().toISOString(),
        pinHash: await hashPin(body.pin),
      });
    } catch (err) {
      // Two requests with the same ticket racing past the check above.
      if ((err as { code?: number }).code === 11000) throw phoneTaken();
      throw err;
    }

    // Every account gets its charge tag immediately, so a driver can charge
    // without ever being asked what a tag is. A failure here does not block
    // sign-up; the tag is issued on first use instead.
    const idTag = await ensureChargeTag(user);
    if (idTag) user = { ...user, idTag };

    setSessionCookie(res, user);
    return { user: toPublicUser(user) };
  }),
);

// ---------------------------------------------------------------------------
// Instant Guest Direct Charging: send code → login (find or create user)
// ---------------------------------------------------------------------------

const guestOwner = (phone: string) => `guest:${phone}`;

authRoutes.post(
  '/guest/send-code',
  route(async (req) => {
    guard(req, 'auth:guest-send-code', 10, HOUR);
    const { phone } = parseBody(req, guestSendCodeSchema);

    const code = await sendSmsCode({
      owner: guestOwner(phone),
      kind: 'phone_verify',
      destination: phone,
      text: (c) => `Tany neg udaagiin code: ${c}.`,
    });

    return { ok: true, destination: maskDestination(phone, 'sms'), ...devOnly({ devCode: code }) };
  }),
);

authRoutes.post(
  '/guest/login',
  route(async (req, res) => {
    guard(req, 'auth:guest-login', 20, HOUR);
    const { phone, code } = parseBody(req, guestLoginSchema);

    if (!(await consumeSmsCode(guestOwner(phone), 'phone_verify', code))) {
      throw invalidCode();
    }

    let user = await store.findUserByPhone(phone);
    if (!user) {
      user = await store.createUser({
        phone,
        phoneVerifiedAt: new Date().toISOString(),
      });
    } else if (!user.isActive) {
      throw unauthorized(WRONG_CREDENTIALS);
    }

    const idTag = user.idTag ?? (await ensureChargeTag(user));
    if (idTag && !user.idTag) {
      user = { ...user, idTag };
    }

    const updated =
      (await store.updateUser(user.id, {
        lastLoginAt: new Date().toISOString(),
      })) ?? user;

    setSessionCookie(res, updated);
    return { ok: true, user: toPublicUser(updated) };
  }),
);

// ---------------------------------------------------------------------------
// PIN reset: send code → verify code (ticket) → new PIN
// ---------------------------------------------------------------------------

const NOT_REGISTERED = 'Энэ дугаараар бүртгэл олдсонгүй';

/** Says when a number is not registered — sign-up already has to, so hiding it protects nothing. */
authRoutes.post(
  '/pin/forgot',
  route(async (req) => {
    guard(req, 'auth:pin-forgot', 5, HOUR);
    const { phone } = parseBody(req, pinForgotSchema);

    const user = await store.findUserByPhone(phone);
    if (!user || !user.isActive) throw new DriverError(404, NOT_REGISTERED, { phone: NOT_REGISTERED });

    const code = await sendSmsCode({
      owner: user.id,
      kind: 'password_reset',
      destination: phone,
      text: templates.pinResetSms,
    });

    return { ok: true, destination: maskDestination(phone, 'sms'), ...devOnly({ devCode: code }) };
  }),
);

authRoutes.post(
  '/pin/verify',
  route(async (req) => {
    guard(req, 'auth:pin-verify', 20, HOUR);
    const { phone, code } = parseBody(req, phoneCodeSchema);

    const user = await store.findUserByPhone(phone);
    if (!user || !user.isActive) throw invalidCode();
    if (!(await consumeSmsCode(user.id, 'password_reset', code))) throw invalidCode();

    return {
      ok: true,
      // Pinned to the current tokenVersion, which the reset bumps, so the ticket
      // is spent the moment it is used.
      resetTicket: issuePhoneTicket('pin_reset', { phone, v: user.tokenVersion ?? 0 }),
    };
  }),
);

/** Stores the new PIN, unlocks the account, signs out every other device and signs this one in. */
authRoutes.post(
  '/pin/reset',
  route(async (req, res) => {
    guard(req, 'auth:pin-reset', 10, HOUR);
    const body = parseBody(req, pinResetSchema);

    const ticket = readPhoneTicket('pin_reset', body.resetTicket);
    if (!ticket) throw expiredTicket();

    const user = await store.findUserByPhone(ticket.phone);
    if (!user || !user.isActive || (user.tokenVersion ?? 0) !== ticket.v) throw expiredTicket();

    const updated = await store.updateUser(user.id, {
      pinHash: await hashPin(body.pin),
      ...clearedPinLock,
      tokenVersion: (user.tokenVersion ?? 0) + 1,
      // Receiving the code proved the number, even on an account from before.
      phoneVerifiedAt: user.phoneVerifiedAt ?? new Date().toISOString(),
    });
    if (!updated) throw notFound('Таны бүртгэлийг олсонгүй');

    setSessionCookie(res, updated);
    return { user: toPublicUser(updated) };
  }),
);

// ---------------------------------------------------------------------------
// Changing the phone number on a signed-in account
// ---------------------------------------------------------------------------

const PHONE_IN_USE = 'Энэ утасны дугаар аль хэдийн бүртгэлтэй байна';

const phoneSendCodeSchema = z.object({
  phone: z.string().trim().max(20).optional(),
});

authRoutes.post(
  '/phone/send-code',
  route(async (req) => {
    const user = await requireUser(req);
    guard(req, 'auth:phone-send-code', 5, HOUR);

    // An empty body re-sends to the number already on file.
    const { phone: requested } = phoneSendCodeSchema.parse(req.body ?? {});

    let destination: string;
    if (requested) {
      const normalized = normalizePhone(requested);
      if (!normalized) {
        throw badRequest('Зөв утасны дугаар оруулна уу', { phone: 'Зөв утасны дугаар оруулна уу' });
      }
      destination = normalized;
    } else if (user.phone) {
      destination = user.phone;
    } else {
      throw badRequest('Эхлээд утасны дугаар нэмнэ үү', { phone: 'Утасны дугаар оруулна уу' });
    }

    const owner = await store.findUserByPhone(destination);
    if (owner && owner.id !== user.id) throw conflict(PHONE_IN_USE, { phone: PHONE_IN_USE });

    const issued = await store.countTokensSince(user.id, 'phone_verify', new Date(Date.now() - HOUR));
    if (issued >= 5) throw tooMany('Хэт олон код хүсэлээ. Нэг цагийн дараа дахин оролдоно уу.');

    await store.invalidateTokens(user.id, 'phone_verify');

    const code = generateOtp();
    // The number is only parked on the token; it moves onto the account once
    // the code comes back in /phone/verify.
    await store.createToken({
      userId: user.id,
      kind: 'phone_verify',
      secretHash: hashSecret(code),
      channel: 'sms',
      destination,
      expiresAt: expiryFor('phone_verify'),
    });

    const delivery = await sendSms({
      to: destination,
      text: templates.phoneVerifySms(code, TOKEN_TTL_MINUTES.phone_verify),
    });
    if (!delivery.delivered) {
      driverLogger.error({ error: delivery.error }, 'phone verification sms not delivered');
      throw smsNotDelivered();
    }

    return {
      ok: true,
      destination: maskDestination(destination, 'sms'),
      ...devOnly({ devCode: code }),
    };
  }),
);

authRoutes.post(
  '/phone/verify',
  route(async (req) => {
    const user = await requireUser(req);
    guard(req, 'auth:phone-verify', 20, HOUR);
    const { code } = parseBody(req, verifyPhoneSchema);

    const candidates = (await store.findActiveTokens(user.id, 'phone_verify')).filter(usableCode);

    let matched: StoredToken | null = null;
    for (const candidate of candidates) {
      if (secretMatches(code, candidate.secretHash)) {
        matched = candidate;
        break;
      }
      const attempts = await store.incrementTokenAttempts(candidate.id);
      if (attempts >= MAX_CODE_ATTEMPTS) await store.markTokenUsed(candidate.id);
    }
    if (!matched) throw invalidCode();

    const owner = await store.findUserByPhone(matched.destination);
    if (owner && owner.id !== user.id) {
      await store.markTokenUsed(matched.id);
      throw conflict(PHONE_IN_USE, { phone: PHONE_IN_USE });
    }

    const updated =
      (await store.updateUser(user.id, {
        phone: matched.destination,
        phoneVerifiedAt: new Date().toISOString(),
      })) ?? user;
    await store.markTokenUsed(matched.id);
    await store.invalidateTokens(user.id, 'phone_verify');

    return { ok: true, user: toPublicUser(updated) };
  }),
);

// ---------------------------------------------------------------------------
// Email verification (email is optional on an account)
// ---------------------------------------------------------------------------

authRoutes.post(
  '/resend-verification',
  route(async (req) => {
    const user = await requireUser(req);
    guard(req, 'auth:resend-verification', 5, HOUR);

    if (!user.email) throw badRequest('Эхлээд и-мэйл хаягаа нэмнэ үү');
    if (user.emailVerifiedAt) throw conflict('Таны и-мэйл хаяг аль хэдийн баталгаажсан байна');

    const issued = await store.countTokensSince(user.id, 'email_verify', new Date(Date.now() - HOUR));
    if (issued >= 10) {
      throw tooMany('Хэт олон баталгаажуулах и-мэйл хүсэлээ. Нэг цагийн дараа дахин оролдоно уу.');
    }

    await store.invalidateTokens(user.id, 'email_verify');

    const secret = generateSecret();
    const token = await store.createToken({
      userId: user.id,
      kind: 'email_verify',
      secretHash: hashSecret(secret),
      channel: 'email',
      destination: user.email,
      expiresAt: expiryFor('email_verify'),
    });

    const linkToken = composeLinkToken(token.id, secret);
    const url = `${env.APP_URL}/verify-email?token=${encodeURIComponent(linkToken)}`;
    const delivery = await sendEmail({ to: user.email, ...templates.verifyEmail(url) });
    if (!delivery.delivered) {
      driverLogger.error({ error: delivery.error }, 'verification email not delivered');
      throw new DriverError(502, 'Одоохондоо и-мэйлийг илгээж чадсангүй. Хэсэг хугацааны дараа дахин оролдоно уу.');
    }

    return {
      ok: true,
      destination: maskDestination(user.email, 'email'),
      ...devOnly({ devToken: linkToken }),
    };
  }),
);

const verifyEmailSchema = z.object({
  token: z.string().trim().min(1, 'Энэ баталгаажуулах холбоос дутуу байна'),
});

const invalidLink = () =>
  badRequest('Энэ баталгаажуулах холбоос буруу эсвэл хугацаа нь дууссан байна. Шинэ холбоос авна уу.', {
    token: 'Энэ баталгаажуулах холбоос хүчингүй болсон байна',
  });

authRoutes.post(
  '/verify-email',
  route(async (req, res) => {
    guard(req, 'auth:verify-email', 20, HOUR);
    const { token: raw } = parseBody(req, verifyEmailSchema);

    const parsed = parseLinkToken(raw);
    if (!parsed) throw invalidLink();

    const token = await store.findTokenById(parsed.id);
    if (!token || token.kind !== 'email_verify' || !usableCode(token)) throw invalidLink();

    if (!secretMatches(parsed.secret, token.secretHash)) {
      const attempts = await store.incrementTokenAttempts(token.id);
      if (attempts >= MAX_CODE_ATTEMPTS) await store.markTokenUsed(token.id);
      throw invalidLink();
    }

    const user = await store.findUserById(token.userId);
    if (!user || !user.isActive) throw invalidLink();

    const updated =
      (await store.updateUser(user.id, {
        emailVerifiedAt: user.emailVerifiedAt ?? new Date().toISOString(),
      })) ?? user;
    await store.markTokenUsed(token.id);
    setSessionCookie(res, updated);

    return { ok: true, user: toPublicUser(updated) };
  }),
);

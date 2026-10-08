import { z } from 'zod';
import { env } from '../config/env';

/**
 * Turns typed local input into E.164 (`+97699112233`). Anything already prefixed
 * with `+` is kept as-is; a leading `00` or a bare national number is expanded
 * with DEFAULT_COUNTRY_CODE.
 */
export function normalizePhone(raw: string, countryCode?: string): string | null {
  const cc = (countryCode ?? env.DEFAULT_COUNTRY_CODE).replace(/\D/g, '');
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let digits = trimmed.replace(/[\s()\-.]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  else if (!digits.startsWith(cc)) digits = `${cc}${digits}`;

  if (!/^\d{8,15}$/.test(digits)) return null;
  return `+${digits}`;
}

const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .email('Зөв и-мэйл хаяг оруулна уу')
  .transform((v) => v.toLowerCase());

const phoneSchema = z
  .string({ message: 'Утасны дугаараа оруулна уу' })
  .trim()
  .min(6, 'Зөв утасны дугаар оруулна уу')
  .max(20)
  .transform((v, ctx) => {
    const normalized = normalizePhone(v);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: 'Зөв утасны дугаар оруулна уу' });
      return z.NEVER;
    }
    return normalized;
  });

/** The sign-in PIN: exactly four digits. */
const pinSchema = z
  .string({ message: '4 оронтой PIN код оруулна уу' })
  .regex(/^\d{4}$/, '4 оронтой PIN код оруулна уу');

/** The 6-digit code sent by SMS. */
const smsCodeSchema = z
  .string({ message: '6 оронтой кодоо оруулна уу' })
  .trim()
  .regex(/^\d{6}$/, '6 оронтой кодоо оруулна уу');

const PIN_MISMATCH = 'PIN код таарахгүй байна';

/** Step 1 of sign-up: the number to text a code to. */
export const signupSendCodeSchema = z.object({
  phone: phoneSchema,
  acceptTerms: z.literal(true, { message: 'Үргэлжлүүлэхийн тулд нөхцөлийг зөвшөөрнө үү' }),
});

/** Step 2 of sign-up and of a PIN reset: the code that came back. */
export const phoneCodeSchema = z.object({
  phone: phoneSchema,
  code: smsCodeSchema,
});

/** Step 3 of sign-up: the new PIN, typed twice. */
export const signupCompleteSchema = z
  .object({
    signupTicket: z.string().min(1, 'Эхний алхмаас дахин эхлүүлнэ үү'),
    pin: pinSchema,
    confirmPin: z.string(),
  })
  .refine((v) => v.pin === v.confirmPin, { message: PIN_MISMATCH, path: ['confirmPin'] });

export const loginSchema = z.object({
  phone: phoneSchema,
  pin: z.string({ message: 'PIN кодоо оруулна уу' }).min(1, 'PIN кодоо оруулна уу').max(12),
});

export const pinForgotSchema = z.object({
  phone: phoneSchema,
});

export const pinResetSchema = z
  .object({
    resetTicket: z.string().min(1, 'Эхний алхмаас дахин эхлүүлнэ үү'),
    pin: pinSchema,
    confirmPin: z.string(),
  })
  .refine((v) => v.pin === v.confirmPin, { message: PIN_MISMATCH, path: ['confirmPin'] });

export const changePinSchema = z
  .object({
    /** Not asked of an account that has never had a PIN. */
    currentPin: z.string().max(12).optional(),
    pin: pinSchema,
    confirmPin: z.string(),
  })
  .refine((v) => v.pin === v.confirmPin, { message: PIN_MISMATCH, path: ['confirmPin'] });

export const updateProfileSchema = z.object({
  name: z.string().trim().max(80).optional(),
  email: emailSchema.optional().or(z.literal('')),
  phone: z.string().trim().max(20).optional().or(z.literal('')),
  locale: z.enum(['en', 'mn']).optional(),
  vehicleBrand: z.string().trim().max(40).optional().or(z.literal('')),
  vehicleModel: z.string().trim().max(40).optional().or(z.literal('')),
});

export const verifyPhoneSchema = z.object({
  code: smsCodeSchema,
});

export const stationQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum(['all', 'available', 'busy', 'offline']).default('all'),
  connectorType: z.string().trim().max(20).optional(),
  minPowerKw: z.coerce.number().min(0).max(1000).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export type StationQuery = z.infer<typeof stationQuerySchema>;

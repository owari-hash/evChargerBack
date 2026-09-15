import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { StoredUser } from '../store';

const ROUNDS = 12;

/** Every this many wrong PINs in a row, the account is locked for a while. */
export const PIN_SOFT_LIMIT = 5;
/** After this many in a row, only an SMS reset unlocks the account. */
export const PIN_HARD_LIMIT = 10;
export const PIN_LOCK_MINUTES = 15;

export function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, ROUNDS);
}

export function verifyPin(pin: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pin, hash);
}

/**
 * Compared against when no account matches, so an unknown number costs the same
 * bcrypt work as a wrong PIN and cannot be probed by timing.
 */
let dummy: Promise<string> | null = null;
export function dummyPinHash(): Promise<string> {
  dummy ??= hashPin(randomBytes(24).toString('base64url'));
  return dummy;
}

export type PinLock =
  | { kind: 'none' }
  | { kind: 'temporary'; minutesLeft: number }
  | { kind: 'reset-required' };

/**
 * A four-digit PIN has only 10,000 values, so guessing is throttled per account
 * rather than per IP address alone.
 */
export function pinLock(user: StoredUser): PinLock {
  if ((user.failedPinAttempts ?? 0) >= PIN_HARD_LIMIT) return { kind: 'reset-required' };
  const until = user.pinLockedUntil ? new Date(user.pinLockedUntil).getTime() : 0;
  if (until > Date.now()) {
    return { kind: 'temporary', minutesLeft: Math.max(1, Math.ceil((until - Date.now()) / 60_000)) };
  }
  return { kind: 'none' };
}

/** The patch to store after a wrong PIN. */
export function failedPinPatch(user: StoredUser): Partial<StoredUser> {
  const failures = (user.failedPinAttempts ?? 0) + 1;
  const patch: Partial<StoredUser> = { failedPinAttempts: failures };
  if (failures < PIN_HARD_LIMIT && failures % PIN_SOFT_LIMIT === 0) {
    patch.pinLockedUntil = new Date(Date.now() + PIN_LOCK_MINUTES * 60_000).toISOString();
  }
  return patch;
}

/** Clears the counters after a correct PIN or a reset. */
export const clearedPinLock: Partial<StoredUser> = {
  failedPinAttempts: 0,
  pinLockedUntil: undefined,
};

export function pinLockMessage(lock: Exclude<PinLock, { kind: 'none' }>): string {
  return lock.kind === 'reset-required'
    ? 'PIN кодыг олон удаа буруу оруулсан тул бүртгэл түгжигдлээ. «PIN код мартсан» хэсгээс SMS кодоор шинэчилнэ үү.'
    : `PIN кодыг олон удаа буруу оруулсан байна. ${lock.minutesLeft} минутын дараа дахин оролдоно уу.`;
}

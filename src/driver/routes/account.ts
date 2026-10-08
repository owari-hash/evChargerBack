import { Router } from 'express';
import { clearedPinLock, hashPin, verifyPin } from '../auth/pin';
import { requireUser, setSessionCookie, toPublicUser } from '../auth/session';
import { badRequest, conflict, guard, HOUR, notFound, parseBody, route } from '../http';
import { store, type StoredUser } from '../store';
import { changePinSchema, normalizePhone, updateProfileSchema } from '../validation';

export const accountRoutes = Router();

const ACCOUNT_NOT_FOUND = 'Таны бүртгэлийг олсонгүй';

/** Deactivates the account and releases its charge tag. */
accountRoutes.delete(
  '/',
  route(async (req) => {
    const user = await requireUser(req);
    const updated = await store.updateUser(user.id, {
      isActive: false,
      idTag: undefined,
      name: 'Deleted User',
    });
    if (!updated) throw notFound(ACCOUNT_NOT_FOUND);
    return { ok: true, message: 'Бүртгэл амжилттай устгагдлаа' };
  }),
);

accountRoutes.patch(
  '/profile',
  route(async (req) => {
    const user = await requireUser(req);
    const body = parseBody(req, updateProfileSchema);

    const patch: Partial<StoredUser> = {};
    if (body.name !== undefined) patch.name = body.name || undefined;
    if (body.locale !== undefined) patch.locale = body.locale;
    if (body.vehicleBrand !== undefined) patch.vehicleBrand = body.vehicleBrand || undefined;
    if (body.vehicleModel !== undefined) patch.vehicleModel = body.vehicleModel || undefined;

    if (body.email !== undefined && (body.email || undefined) !== user.email) {
      if (body.email) {
        const existing = await store.findUserByEmail(body.email);
        if (existing && existing.id !== user.id) {
          throw conflict('Энэ и-мэйл хаяг аль хэдийн ашиглагдаж байна', {
            email: 'Энэ и-мэйл хаяг өөр бүртгэлд холбогдсон байна',
          });
        }
      }
      // Email is optional, so clearing the field removes it from the account.
      patch.email = body.email || undefined;
      patch.emailVerifiedAt = undefined;
    }

    // The phone number is how the driver signs in, so it only ever changes
    // through the SMS code flow — never by typing it here.
    if (body.phone !== undefined) {
      const phone = body.phone ? normalizePhone(body.phone) : null;
      if (phone !== (user.phone ?? null)) {
        throw badRequest('Утасны дугаараа «Аюулгүй байдал» хэсэгт SMS кодоор баталгаажуулж солино уу', {
          phone: 'Утасны дугаарыг SMS кодоор баталгаажуулж солино',
        });
      }
    }

    if (Object.keys(patch).length === 0) return { user: toPublicUser(user) };

    const updated = await store.updateUser(user.id, patch);
    if (!updated) throw notFound(ACCOUNT_NOT_FOUND);
    return { user: toPublicUser(updated) };
  }),
);

/** Changes the sign-in PIN, or sets the first one on an account that has none. */
accountRoutes.post(
  '/pin',
  route(async (req, res) => {
    const user = await requireUser(req);
    guard(req, `account-pin:${user.id}`, 10, HOUR);
    const body = parseBody(req, changePinSchema);

    if (user.pinHash) {
      const matches = body.currentPin ? await verifyPin(body.currentPin, user.pinHash) : false;
      if (!matches) {
        throw badRequest('Тэмдэглэсэн талбаруудаа шалгана уу', {
          currentPin: 'Одоогийн PIN код буруу байна',
        });
      }
    }

    const updated = await store.updateUser(user.id, {
      pinHash: await hashPin(body.pin),
      ...clearedPinLock,
      tokenVersion: (user.tokenVersion ?? 0) + 1,
    });
    if (!updated) throw notFound(ACCOUNT_NOT_FOUND);

    // Bumping tokenVersion invalidates every existing cookie; re-issuing one
    // keeps this device signed in while other devices are signed out.
    setSessionCookie(res, updated);
    return { ok: true, user: toPublicUser(updated) };
  }),
);

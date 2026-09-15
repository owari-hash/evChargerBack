import { randomInt } from 'node:crypto';
import { IdTag } from '../models/IdTag';
import { bindIdTagToWallet } from '../services/wallet.service';
import { driverLogger } from './http';
import { store, type StoredUser } from './store';

/**
 * The charge tag is the only identity OCPP understands: the station sends it in
 * `Authorize` and `StartTransaction`, and the account, the wallet and the
 * session history all hang off it.
 *
 * One is generated per account at sign-up, so a driver never has to know it
 * exists. It is not derived from the account id on purpose: the tag travels in
 * the clear through OCPP logs and station displays, and has to stay replaceable.
 */

/** Retries cover the vanishingly unlikely case of a generated tag colliding. */
const ATTEMPTS = 5;

/**
 * No `0/O`, `1/I/L`, `5/S`, `2/Z` — a driver reading their tag to support over
 * the phone should not have to guess. `EV` + 10 stays inside OCPP's 20 chars.
 */
const ALPHABET = '34679ACDEFGHJKMNPQRTUVWXY';

function generateChargeTag(): string {
  let body = '';
  for (let i = 0; i < 10; i++) body += ALPHABET[randomInt(ALPHABET.length)];
  return `EV${body}`;
}

/**
 * Ensures the account has a usable charge tag, creating one if needed.
 *
 * Safe to call more than once: an account that already has a tag keeps it, and
 * the IdTag record and wallet binding are re-asserted, which repairs a tag that
 * never made it that far.
 */
export async function ensureChargeTag(user: StoredUser): Promise<string | undefined> {
  if (user.idTag) {
    await register(user.idTag, user).catch((err: unknown) =>
      driverLogger.warn({ err, idTag: user.idTag }, 'could not re-assert charge tag'),
    );
    return user.idTag;
  }

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const idTag = generateChargeTag();
    if (await IdTag.exists({ _id: idTag })) continue;
    try {
      await register(idTag, user);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) continue;
      driverLogger.warn({ err }, 'could not create charge tag');
      return undefined;
    }

    await store.updateUser(user.id, { idTag });
    return idTag;
  }

  driverLogger.warn('gave up generating a unique charge tag');
  return undefined;
}

/** Creates the IdTag and points it at this account's wallet. */
async function register(idTag: string, user: StoredUser): Promise<void> {
  if (!(await IdTag.exists({ _id: idTag }))) {
    await IdTag.create({
      _id: idTag,
      status: 'Accepted',
      label: user.name || user.phone || user.email,
      ownerEmail: user.email,
      ownerName: user.name,
      // One car at a time per driver; a second simultaneous charge is refused.
      maxActiveTransactions: 1,
      // Empty allow-list: valid at every station on the network.
      allowedChargePointIds: [],
    });
  }

  // Charging then draws on the account balance rather than the tag's own.
  await bindIdTagToWallet(idTag, { ownerType: 'USER', ownerId: user.id }).catch((err: unknown) =>
    driverLogger.warn({ err, idTag }, 'could not bind charge tag to wallet'),
  );
}

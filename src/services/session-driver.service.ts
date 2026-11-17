/**
 * Resolves who charged each session: the driver's phone and their RFID card(s).
 *
 * A driver account carries an app tag (`DriverUser.idTag`, e.g. EVMUGDU9TRRJ) used
 * for app/remote starts; physical RFID cards are separate IdTag records whose
 * wallet points at the driver (`walletOwnerType: 'USER'`). So a session started
 * with a card has that card as its idTag, and one started from the app has the
 * app tag — for those we show the driver's linked cards instead.
 */
import { isValidObjectId } from 'mongoose';
import { DriverUser } from '../driver/store';
import { IdTag } from '../models/IdTag';

export interface SessionDriverInfo {
  driverName: string;
  driverPhone: string;
  /** RFID card number(s): the card used, or the driver's linked cards for app starts. */
  rfid: string;
  /** How the session was authorised. */
  startedBy: 'APP' | 'CARD' | 'UNKNOWN';
}

/** Keep only the last 4 digits so station owners can tell drivers apart without seeing contacts. */
export function maskPhone(phone?: string | null): string {
  if (!phone) return '';
  return phone.length <= 4 ? phone : `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`;
}

export async function resolveSessionDrivers(
  txs: { idTag: string }[],
  opts: { maskContacts?: boolean } = {},
): Promise<Map<string, SessionDriverInfo>> {
  const out = new Map<string, SessionDriverInfo>();
  const tagIds = [...new Set(txs.map((t) => t.idTag).filter(Boolean))];
  if (!tagIds.length) return out;

  const tags = await IdTag.find({ _id: { $in: tagIds } })
    .select('_id ownerName ownerPhone label walletOwnerType walletOwnerId')
    .lean();
  const tagById = new Map(tags.map((t) => [String(t._id), t]));

  const ownerIds = tags
    .filter((t) => t.walletOwnerType === 'USER' && t.walletOwnerId && isValidObjectId(t.walletOwnerId))
    .map((t) => String(t.walletOwnerId));
  const drivers = await DriverUser.find({ $or: [{ idTag: { $in: tagIds } }, { _id: { $in: ownerIds } }] })
    .select('_id name phone idTag')
    .lean();
  const driverById = new Map(drivers.map((d) => [String(d._id), d]));
  const driverByTag = new Map(drivers.filter((d) => d.idTag).map((d) => [String(d.idTag), d]));

  // Every RFID card linked to these drivers (for sessions started from the app).
  const cards = drivers.length
    ? await IdTag.find({ walletOwnerType: 'USER', walletOwnerId: { $in: drivers.map((d) => String(d._id)) } })
        .select('_id walletOwnerId')
        .lean()
    : [];
  const cardsByDriver = new Map<string, string[]>();
  for (const c of cards) {
    const driverId = String(c.walletOwnerId);
    const appTag = driverById.get(driverId)?.idTag;
    if (String(c._id) === appTag) continue; // the app tag is not a card
    const list = cardsByDriver.get(driverId) ?? [];
    list.push(String(c._id));
    cardsByDriver.set(driverId, list);
  }

  for (const idTag of tagIds) {
    const tag = tagById.get(idTag);
    const appDriver = driverByTag.get(idTag);
    const cardDriver =
      !appDriver && tag?.walletOwnerType === 'USER' && tag.walletOwnerId
        ? driverById.get(String(tag.walletOwnerId))
        : undefined;
    const driver = appDriver ?? cardDriver;
    const phone = driver?.phone ?? tag?.ownerPhone ?? '';

    let rfid = '';
    let startedBy: SessionDriverInfo['startedBy'] = 'UNKNOWN';
    if (appDriver) {
      startedBy = 'APP';
      rfid = (cardsByDriver.get(String(appDriver._id)) ?? []).join(', ');
    } else if (tag) {
      startedBy = 'CARD';
      rfid = idTag;
    }

    out.set(idTag, {
      driverName: driver?.name ?? tag?.ownerName ?? tag?.label ?? '',
      driverPhone: opts.maskContacts ? maskPhone(phone) : phone,
      rfid,
      startedBy,
    });
  }
  return out;
}

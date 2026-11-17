/**
 * Resolves who charged each session: the driver's name and phone.
 *
 * A session's idTag is either a driver's app tag (`DriverUser.idTag`) or an RFID
 * card whose wallet points at the driver (`walletOwnerType: 'USER'`); cards not
 * tied to an account fall back to the owner details stored on the card.
 */
import { isValidObjectId } from 'mongoose';
import { DriverUser } from '../driver/store';
import { IdTag } from '../models/IdTag';

export interface SessionDriverInfo {
  driverName: string;
  driverPhone: string;
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

  for (const idTag of tagIds) {
    const tag = tagById.get(idTag);
    const appDriver = driverByTag.get(idTag);
    const cardDriver =
      !appDriver && tag?.walletOwnerType === 'USER' && tag.walletOwnerId
        ? driverById.get(String(tag.walletOwnerId))
        : undefined;
    const driver = appDriver ?? cardDriver;
    const phone = driver?.phone ?? tag?.ownerPhone ?? '';

    out.set(idTag, {
      driverName: driver?.name ?? tag?.ownerName ?? tag?.label ?? '',
      driverPhone: opts.maskContacts ? maskPhone(phone) : phone,
    });
  }
  return out;
}

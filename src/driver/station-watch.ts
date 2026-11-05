import { DriverNotification } from '../models/DriverNotification';
import { StationWatch } from '../models/StationWatch';
import { bus } from '../realtime/events';
import { broadcastNotification } from '../realtime/notification-socket';
import { getStation } from './charging';
import { driverLogger } from './http';

/** A watch outlives one visit to the station page, but not a whole day. */
export const WATCH_TTL_MS = 2 * 60 * 60 * 1000;

export interface WatchState {
  watching: boolean;
  expiresAt: string | null;
}

export async function getWatch(userId: string, stationId: string): Promise<WatchState> {
  const doc = await StationWatch.findOne({ userId, stationId, expiresAt: { $gt: new Date() } }).lean();
  return { watching: Boolean(doc), expiresAt: doc ? doc.expiresAt.toISOString() : null };
}

export async function startWatch(
  userId: string,
  station: { id: string; cpId: string },
): Promise<WatchState> {
  const expiresAt = new Date(Date.now() + WATCH_TTL_MS);
  await StationWatch.updateOne(
    { userId, stationId: station.id },
    { $set: { cpId: station.cpId, expiresAt } },
    { upsert: true },
  );
  return { watching: true, expiresAt: expiresAt.toISOString() };
}

export async function stopWatch(userId: string, stationId: string): Promise<WatchState> {
  await StationWatch.deleteOne({ userId, stationId });
  return { watching: false, expiresAt: null };
}

/** Files the bell entry and pushes it to every open tab and app of that driver. */
async function notifyFree(userId: string, stationId: string, stationName: string): Promise<void> {
  const dedupeKey = `station-free:${stationId}:${Math.floor(Date.now() / 60_000)}`;
  const doc = await DriverNotification.create({
    userId,
    kind: 'station-free',
    title: 'Цэнэглэгч сул боллоо',
    body: `${stationName} станцад сул цэнэглэгч гарлаа. Хурдан очвол таных.`,
    href: `/stations/${stationId}`,
    dedupeKey,
    at: new Date(),
    isRead: false,
  });
  broadcastNotification(
    { userId, role: 'driver' },
    {
      id: String(doc._id),
      kind: doc.kind,
      title: doc.title,
      body: doc.body,
      imageUrl: null,
      href: doc.href,
      dedupeKey,
      at: doc.at ? doc.at.toISOString() : new Date().toISOString(),
      isRead: false,
    },
  );
}

let started = false;

/** Listens for plugs turning Available and fires the matching watches once. */
export function startStationWatchers(): void {
  if (started) return;
  started = true;

  bus.on('connector.status', (e) => {
    const data = e.data as { connectorId?: number; status?: string } | undefined;
    if (!e.chargePointId || data?.status !== 'Available' || !data.connectorId) return;
    const cpId = e.chargePointId;

    void (async () => {
      const watches = await StationWatch.find({ cpId, expiresAt: { $gt: new Date() } }).lean();
      if (watches.length === 0) return;

      const station = await getStation(cpId);
      const name = station?.name ?? cpId;
      for (const w of watches) {
        // Deleted first, so two quick "Available" reports can't notify twice.
        const { deletedCount } = await StationWatch.deleteOne({ _id: w._id });
        if (deletedCount === 0) continue;
        await notifyFree(w.userId, w.stationId, name);
      }
    })().catch((err: unknown) => driverLogger.warn({ err, cpId }, 'station watch notify failed'));
  });
}

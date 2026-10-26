import { findChargePoint, requireChargePoint } from '../lib/chargePointRef';
import { badRequest, notFound } from '../lib/errors';
import { DriverError, driverLogger } from './http';
import { env } from '../config/env';
import { HttpError } from '../lib/errors';
import { Reservation } from '../models/Reservation';
import { CallTimeoutError, OcppRpcError } from '../ocpp/types';
import { hasBalanceToStart, isInternalTag } from '../services/wallet.service';
import { ChargePoint } from '../models/ChargePoint';
import { Client } from '../models/Client';
import {
  activeTariffZone,
  currentStationTariff,
  driverTariff,
  feePercentForStation,
  resolveFeePercent,
  type TariffZone,
} from '../services/pricing.service';
import { Connector } from '../models/Connector';
import { IdTag } from '../models/IdTag';
import { Transaction } from '../models/Transaction';
import { connectionManager } from '../ocpp/manager';
import { issueEBarimtForTransaction } from '../services/ebarimt.service';
import { estimateMinutesToFull } from './charge-estimate';
import {
  CONNECTOR_TYPES,
  type ChargingSession,
  type ConnectorStatus,
  type ConnectorType,
  type EBarimtData,
  type Station,
  type StationAvailability,
  type StationConnector,
} from './types';
import type { StationQuery } from './validation';

/**
 * Stations and charging sessions as a driver sees them, read straight from the
 * CSMS collections and OCPP connection registry in this process.
 */

const iso = (value: unknown): string | undefined =>
  value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : undefined;

/**
 * Charge points created before `scripts/migrate-charge-point-ids.ts` still carry
 * their OCPP name as `_id`. Such an id cannot be cast for an ObjectId reference
 * query, and one of them must not fail the whole station list.
 */
const objectIdsOnly = (ids: unknown[]): string[] =>
  ids.map(String).filter((id) => /^[a-f\d]{24}$/i.test(id));

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

interface RawConnector {
  connectorId: number;
  /** Operator-set in the console; OCPP 1.6 reports none of these. */
  connectorType?: string | null;
  powerKw?: number | null;
  label?: string | null;
  status?: string;
  errorCode?: string;
  availability?: string;
  currentTransactionId?: number | null;
  lastPowerW?: number;
  lastSocPercent?: number;
  statusTimestamp?: Date;
  hold?: { idTag?: string | null; until?: Date | null } | null;
  pendingStart?: { idTag?: string | null; at?: Date | null } | null;
}

/** A driver scanned this gun and has it open, or a start on it is in flight. */
function takenByScan(c: RawConnector, now: number): boolean {
  const holdLive = Boolean(c.hold?.idTag && c.hold.until && c.hold.until.getTime() > now);
  const startLive = Boolean(
    c.pendingStart?.idTag &&
      c.pendingStart.at &&
      c.pendingStart.at.getTime() > now - PENDING_START_STALE_MS,
  );
  return holdLive || startLive;
}

interface RawChargePoint {
  _id: unknown;
  cpId: string;
  name?: string;
  description?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  tariffPerKwh?: number;
  tariffZones?: TariffZone[];
  feePercent?: number;
  clientId?: unknown;
  chargePointVendor?: string;
  chargePointModel?: string;
  tags?: string[];
  lastSeenAt?: Date;
}

/**
 * The CSMS stores no plug metadata, so the driver-facing plug type and power are
 * read from the charge point's free-form `tags` (e.g. `ccs2`, `type2`, `60kw`).
 * Tag a connector explicitly with `c2:ccs2` / `c2:60kw` to target connector 2.
 */
const TYPE_ALIASES: Record<string, ConnectorType> = {
  type2: 'Type2',
  mennekes: 'Type2',
  iec62196: 'Type2',
  ccs: 'CCS2',
  ccs2: 'CCS2',
  combo2: 'CCS2',
  chademo: 'CHAdeMO',
  gbt: 'GBT',
  'gb/t': 'GBT',
  type1: 'Type1',
  j1772: 'Type1',
  schuko: 'Schuko',
};

const CONNECTOR_STATUSES: readonly string[] = [
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEV',
  'SuspendedEVSE',
  'Finishing',
  'Reserved',
  'Unavailable',
  'Faulted',
];

interface TagInfo {
  types: ConnectorType[];
  powerKw?: number;
  perConnector: Map<number, { type?: ConnectorType; powerKw?: number }>;
}

function parseTags(tags: string[]): TagInfo {
  const info: TagInfo = { types: [], perConnector: new Map() };

  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (!tag) continue;

    const scoped = /^c(\d+):(.+)$/.exec(tag);
    const value = scoped ? scoped[2]! : tag;
    const connectorId = scoped ? Number(scoped[1]) : undefined;

    const type = TYPE_ALIASES[value];
    const power = /^(\d+(?:\.\d+)?)\s*kw$/.exec(value);

    if (connectorId !== undefined) {
      const entry = info.perConnector.get(connectorId) ?? {};
      if (type) entry.type = type;
      if (power) entry.powerKw = Number(power[1]);
      info.perConnector.set(connectorId, entry);
      if (type && !info.types.includes(type)) info.types.push(type);
      continue;
    }

    if (type && !info.types.includes(type)) info.types.push(type);
    if (power) info.powerKw = Math.max(info.powerKw ?? 0, Number(power[1]));
  }

  return info;
}

function toStation(cp: RawChargePoint, rawConnectors: RawConnector[], feePercent: number): Station {
  const id = String(cp._id);
  const tags = cp.tags ?? [];
  const tagInfo = parseTags(tags);
  // The registry is keyed by the OCPP identifier the station connects with.
  const isOnline = connectionManager.isOnline(cp.cpId);

  // connectorId 0 addresses the charge point as a whole, not a physical socket.
  const connectors: StationConnector[] = rawConnectors
    .filter((c) => c.connectorId > 0)
    .sort((a, b) => a.connectorId - b.connectorId)
    .map((c) => {
      const scoped = tagInfo.perConnector.get(c.connectorId);
      const rawStatus = c.status ?? 'Unavailable';
      return {
        connectorId: c.connectorId,
        // An offline station cannot report a live status; show it as unavailable.
        status:
          isOnline && CONNECTOR_STATUSES.includes(rawStatus)
            ? (rawStatus as ConnectorStatus)
            : 'Unavailable',
        errorCode: c.errorCode ?? 'NoError',
        availability: c.availability === 'Inoperative' ? 'Inoperative' : 'Operative',
        // The connector's own fields win: they are set by an operator in the
        // console and are what the QR sticker is printed from. Tags remain the
        // fallback for stations configured before those fields existed.
        type: (c.connectorType as ConnectorType | undefined) ?? scoped?.type ?? tagInfo.types[0],
        powerKw: c.powerKw ?? scoped?.powerKw ?? tagInfo.powerKw,
        label: c.label ?? undefined,
        currentTransactionId: c.currentTransactionId ?? null,
        lastPowerW: c.lastPowerW,
        lastSocPercent: c.lastSocPercent,
        statusTimestamp: iso(c.statusTimestamp),
      };
    });

  // A gun someone has just scanned is not free on the map either.
  const now = Date.now();
  const scanTaken = new Set(
    rawConnectors.filter((c) => takenByScan(c, now)).map((c) => c.connectorId),
  );
  const availableConnectors = connectors.filter(
    (c) =>
      c.status === 'Available' && c.availability === 'Operative' && !scanTaken.has(c.connectorId),
  ).length;

  let availability: StationAvailability;
  if (!isOnline) availability = 'offline';
  else if (connectors.length === 0) availability = 'unknown';
  else availability = availableConnectors > 0 ? 'available' : 'busy';

  const connectorTypes = [
    ...new Set(connectors.map((c) => c.type).filter((t): t is ConnectorType => Boolean(t))),
  ].sort((a, b) => CONNECTOR_TYPES.indexOf(a) - CONNECTOR_TYPES.indexOf(b));

  const powers = connectors.map((c) => c.powerKw).filter((p): p is number => typeof p === 'number');

  return {
    id,
    cpId: cp.cpId,
    // The OCPP identifier keeps an unnamed station readable instead of a hex id.
    name: cp.name?.trim() || cp.cpId || id,
    description: cp.description,
    address: cp.address,
    latitude: cp.latitude,
    longitude: cp.longitude,
    // What the driver pays per kWh, Eplug's fee included; every client shows
    // and estimates with this. Resolved live against the station's time-of-day
    // zones, so a station with a cheaper night rate shows it the moment the
    // zone starts — nothing has to push an update for this to change.
    tariffPerKwh: driverTariff(currentStationTariff(cp), feePercent),
    baseTariffPerKwh: currentStationTariff(cp),
    defaultTariffPerKwh: cp.tariffPerKwh,
    currentTariffZoneName: activeTariffZone(cp.tariffZones, new Date())?.name || undefined,
    tariffZones: cp.tariffZones?.length
      ? [...cp.tariffZones]
          .sort((a, b) => a.startMinute - b.startMinute)
          .map(({ name, startMinute, endMinute, tariffPerKwh }) => ({
            name: name || undefined,
            startMinute,
            endMinute,
            tariffPerKwh,
          }))
      : undefined,
    feePercent,
    vendor: cp.chargePointVendor,
    model: cp.chargePointModel,
    tags,
    isOnline,
    lastSeenAt: iso(cp.lastSeenAt),
    connectors,
    totalConnectors: connectors.length,
    availableConnectors,
    maxPowerKw: powers.length ? Math.max(...powers) : tagInfo.powerKw,
    connectorTypes,
    availability,
  };
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function matches(station: Station, query: StationQuery): boolean {
  if (query.status && query.status !== 'all' && station.availability !== query.status) return false;

  if (query.connectorType) {
    const wanted = query.connectorType.toLowerCase();
    if (!station.connectorTypes.some((t) => t.toLowerCase() === wanted)) return false;
  }

  if (query.minPowerKw && (station.maxPowerKw ?? 0) < query.minPowerKw) return false;

  if (query.search) {
    const needle = query.search.toLowerCase();
    const haystack = [station.id, station.name, station.address, station.description, ...station.tags]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }

  return true;
}

const AVAILABILITY_RANK: Record<StationAvailability, number> = {
  available: 0,
  busy: 1,
  unknown: 2,
  offline: 3,
};

/** `demo` stays in the payload because both clients read it; it is always false now. */
export async function listStations(
  query: StationQuery,
): Promise<{ stations: Station[]; demo: false }> {
  // Stations an operator switched off «Kiosk-д харуулах» are left out.
  const chargePoints = await ChargePoint.find({ showOnKiosk: { $ne: false } })
    .sort({ _id: 1 })
    .limit(500)
    .lean<RawChargePoint[]>();
  const connectors = await Connector.find({
    chargePointId: { $in: objectIdsOnly(chargePoints.map((cp) => cp._id)) },
  }).lean<Array<RawConnector & { chargePointId: unknown }>>();

  const clientIds = objectIdsOnly(chargePoints.map((cp) => cp.clientId).filter(Boolean));
  const clients = clientIds.length
    ? await Client.find({ _id: { $in: clientIds } }).select('feePercent').lean()
    : [];
  const clientFee = new Map(clients.map((c) => [String(c._id), c]));

  const origin =
    query.lat !== undefined && query.lng !== undefined ? { lat: query.lat, lng: query.lng } : undefined;

  const stations = chargePoints
    .map((cp) =>
      toStation(
        cp,
        connectors.filter((c) => String(c.chargePointId) === String(cp._id)),
        resolveFeePercent(cp, cp.clientId ? clientFee.get(String(cp.clientId)) : null),
      ),
    )
    .map((station) => {
      if (!origin || station.latitude === undefined || station.longitude === undefined) {
        return station;
      }
      return {
        ...station,
        distanceKm: haversineKm(origin, { lat: station.latitude, lng: station.longitude }),
      };
    })
    .filter((station) => matches(station, query))
    .sort((a, b) => {
      if (origin) {
        // Stations without coordinates sink to the bottom of a nearby search.
        const da = a.distanceKm ?? Number.POSITIVE_INFINITY;
        const db = b.distanceKm ?? Number.POSITIVE_INFINITY;
        if (da !== db) return da - db;
      }
      const rank = AVAILABILITY_RANK[a.availability] - AVAILABILITY_RANK[b.availability];
      return rank !== 0 ? rank : a.name.localeCompare(b.name);
    })
    .slice(0, query.limit ?? 200);

  return { stations: await withChargeEstimates(stations), demo: false };
}

/** A station by either identifier — the ObjectId or the OCPP name. */
export async function getStation(idOrCpId: string): Promise<Station | null> {
  const cp = await findChargePoint(idOrCpId);
  if (!cp) return null;
  const raw = cp.toObject() as unknown as RawChargePoint;
  const connectors = await Connector.find({ chargePointId: cp._id }).lean<RawConnector[]>();
  const [station] = await withChargeEstimates([toStation(raw, connectors, await feePercentForStation(cp))]);
  return station!;
}

/** Recent "minutes to full" answers, so a list polled every few seconds is not a query per gun each time. */
const estimateCache = new Map<number, { at: number; minutes: number | undefined }>();
const ESTIMATE_TTL_MS = 30_000;

async function cachedMinutesToFull(transactionId: number): Promise<number | undefined> {
  const now = Date.now();
  const hit = estimateCache.get(transactionId);
  if (hit && now - hit.at < ESTIMATE_TTL_MS) return hit.minutes;
  let minutes: number | undefined;
  try {
    minutes = await estimateMinutesToFull(transactionId);
  } catch (err) {
    driverLogger.warn({ err, transactionId }, 'charge estimate failed');
  }
  if (estimateCache.size > 500) estimateCache.clear();
  estimateCache.set(transactionId, { at: now, minutes });
  return minutes;
}

/** A gun with a car on it right now, as opposed to one idle or just finished. */
function chargingNow(c: StationConnector): boolean {
  return (
    c.currentTransactionId != null &&
    (c.status === 'Charging' || c.status === 'SuspendedEV' || c.status === 'SuspendedEVSE')
  );
}

/**
 * Adds battery-to-full times to the guns charging a car that reports its
 * battery, so a busy station can say how long until it frees up. A battery
 * reading left over from a finished charge is dropped rather than shown.
 */
async function withChargeEstimates(stations: Station[]): Promise<Station[]> {
  return Promise.all(
    stations.map(async (station) => {
      if (!station.connectors.some((c) => c.lastSocPercent != null || chargingNow(c))) return station;
      const connectors = await Promise.all(
        station.connectors.map(async (c) => {
          if (!chargingNow(c)) {
            const { lastSocPercent: _stale, ...rest } = c;
            return rest;
          }
          if (c.lastSocPercent == null) return c;
          const minutesToFull = await cachedMinutesToFull(c.currentTransactionId!);
          return minutesToFull === undefined ? c : { ...c, minutesToFull };
        }),
      );
      return { ...station, connectors };
    }),
  );
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

interface RawTransaction {
  _id: number;
  chargePointId: unknown;
  connectorId: number;
  idTag: string;
  status: ChargingSession['status'];
  startTimestamp: Date;
  stopTimestamp?: Date;
  energyWh?: number;
  cost?: number;
  energyCost?: number;
  feeAmount?: number;
  feePercent?: number;
  lastPowerW?: number;
  lastSocPercent?: number;
  stopReason?: string | null;
  ebarimt?: unknown;
  /** Station's flat rate at start; the blended rate once billed. */
  tariffPerKwh?: number;
  /** The station's time-of-day zones as they were when the session started. */
  tariffZones?: TariffZone[];
}

/**
 * The rate this session is billed at: while running, the zone in effect right
 * now from the zones frozen at start (so a later price edit does not touch
 * it); once finished, the blended rate it was actually billed at.
 */
function sessionTariff(tx: RawTransaction): { tariffPerKwh?: number; tariffZoneName?: string } {
  if (tx.status !== 'Active') return { tariffPerKwh: tx.tariffPerKwh };
  const zone = activeTariffZone(tx.tariffZones, new Date());
  return zone
    ? { tariffPerKwh: zone.tariffPerKwh, tariffZoneName: zone.name || undefined }
    : { tariffPerKwh: tx.tariffPerKwh };
}

function toSession(tx: RawTransaction): ChargingSession {
  return {
    ...sessionTariff(tx),
    transactionId: tx._id,
    chargePointId: String(tx.chargePointId),
    connectorId: tx.connectorId,
    idTag: tx.idTag,
    status: tx.status,
    startTimestamp: iso(tx.startTimestamp) ?? '',
    stopTimestamp: iso(tx.stopTimestamp),
    energyKwh: Number(((tx.energyWh ?? 0) / 1000).toFixed(3)),
    cost: tx.cost,
    energyCost: tx.energyCost,
    feeAmount: tx.feeAmount,
    feePercent: tx.feePercent,
    lastPowerW: tx.lastPowerW,
    lastSocPercent: tx.lastSocPercent,
    stopReason: tx.stopReason ?? undefined,
    ebarimt: tx.ebarimt as EBarimtData | undefined,
  };
}

/** Sessions charged against one account's tag, newest first. */
export async function listSessionsForIdTag(
  idTag: string | undefined,
  limit: number,
): Promise<ChargingSession[]> {
  // An account whose tag has not been issued yet has no history.
  if (!idTag) return [];
  try {
    const rows = await Transaction.find({ idTag })
      .sort({ startTimestamp: -1 })
      .limit(limit)
      .lean<RawTransaction[]>();
    return await Promise.all(rows.map(toSession).map(withEstimate));
  } catch (err) {
    driverLogger.warn({ err, idTag }, 'failed to load transactions');
    return [];
  }
}

/** Attaches station names to sessions so the history is readable. */
export async function decorateSessions(sessions: ChargingSession[]): Promise<ChargingSession[]> {
  const ids = [...new Set(sessions.map((s) => s.chargePointId))];
  if (ids.length === 0) return sessions;

  const validObjIds = objectIdsOnly(ids);
  const stations = await ChargePoint.find({
    $or: [
      ...(validObjIds.length > 0 ? [{ _id: { $in: validObjIds } }] : []),
      { cpId: { $in: ids } },
    ],
  })
    .select('name description sitePath cpId')
    .lean<Array<{ _id: unknown; name?: string; description?: string; sitePath?: string; cpId: string }>>();

  const names = new Map<string, string>();
  for (const cp of stations) {
    const friendlyName = cp.name?.trim() || cp.description?.trim() || cp.sitePath?.trim() || cp.cpId;
    names.set(String(cp._id), friendlyName);
    names.set(cp.cpId, friendlyName);
  }

  return sessions.map((s) => ({
    ...s,
    stationName: names.get(s.chargePointId) || s.stationName,
  }));
}

export async function getTransaction(id: number): Promise<ChargingSession | null> {
  const tx = await Transaction.findById(id).lean<RawTransaction>();
  return tx ? withEstimate(toSession(tx)) : null;
}

/** Adds "minutes to full" to a running session whose station reports battery %. */
async function withEstimate(session: ChargingSession): Promise<ChargingSession> {
  if (session.status !== 'Active' || session.lastSocPercent == null) return session;
  try {
    const minutesToFull = await estimateMinutesToFull(session.transactionId);
    return minutesToFull === undefined ? session : { ...session, minutesToFull };
  } catch (err) {
    driverLogger.warn({ err, transactionId: session.transactionId }, 'charge estimate failed');
    return session;
  }
}

/** Send to a station, with the failures put the way a driver can act on them. */
async function sendToStation<T>(cpId: string, action: string, payload: unknown, issuedBy: string): Promise<T> {
  try {
    return await connectionManager.send<T>(cpId, action, payload, issuedBy);
  } catch (err) {
    if (err instanceof HttpError && err.status === 503) {
      throw new DriverError(503, 'Станц холбогдохгүй байна. Түр хүлээгээд дахин оролдоно уу.');
    }
    if (err instanceof CallTimeoutError) {
      throw new DriverError(504, 'Станц хариу өгсөнгүй. Дахин оролдоно уу.');
    }
    if (err instanceof OcppRpcError) {
      throw new DriverError(502, 'Станцад алдаа гарлаа. Дахин оролдоно уу.');
    }
    throw err;
  }
}

/**
 * How long a claim from {@link claimConnectorForStart} blocks a second scan.
 * Long enough to cover the RemoteStartTransaction round trip plus the
 * station's own StartTransaction.req (a few seconds, worst case); short
 * enough that a claim nothing ever answers — the RPC call itself throws
 * before reaching the `finally` that releases it, say — does not strand the
 * connector. Real success clears the claim immediately rather than waiting
 * this out; this is only the ceiling for the unanswered case.
 */
const PENDING_START_STALE_MS = 25_000;

/**
 * Atomically marks a connector as "a start is in flight for this idTag" —
 * the guard a second, near-simultaneous scan of the same QR code needs. Two
 * `remoteStart` calls can both read `Connector.status: 'Available'` before
 * either's RemoteStartTransaction reaches the station (status only updates
 * once the station's StatusNotification/StartTransaction arrives, seconds
 * later); without an atomic claim here both would be sent to the station,
 * and the second StartTransaction.req would look like a reconnect and
 * silently close the first driver's genuinely live session (see
 * `transaction.service.ts`'s stale-transaction cleanup).
 *
 * Returns true if this call won the claim, false if another is already
 * in flight (and not yet stale).
 */
async function claimConnectorForStart(
  chargePointId: unknown,
  connectorId: number,
  idTag: string,
): Promise<boolean> {
  const now = Date.now();
  const staleBefore = new Date(now - PENDING_START_STALE_MS);
  const claimed = await Connector.findOneAndUpdate(
    {
      chargePointId,
      connectorId,
      availability: { $ne: 'Inoperative' },
      status: { $in: ['Available', 'Preparing', 'Reserved'] },
      $and: [
        { $or: [{ pendingStart: null }, { 'pendingStart.at': { $lt: staleBefore } }] },
        // Someone else scanned this gun first and still has it open.
        { $or: freeOfOtherHolds(idTag, new Date(now)) },
      ],
    },
    { $set: { pendingStart: { idTag, at: new Date(now) } } },
  );
  return claimed !== null;
}

/** Releases a claim this call took out, so a retry (by this driver or the
 *  next one) does not have to wait out the full staleness window. */
async function releaseConnectorClaim(chargePointId: unknown, connectorId: number): Promise<void> {
  await Connector.updateOne({ chargePointId, connectorId }, { $set: { pendingStart: null } }).catch(
    () => {
      // Best-effort: the claim still expires on its own via PENDING_START_STALE_MS.
    },
  );
}

// ---------------------------------------------------------------------------
// Scan holds — "I'm standing at this gun"
// ---------------------------------------------------------------------------

/**
 * How long a scan hold lasts without being refreshed. The kiosk and app
 * refresh it every few seconds while the driver has the scanned gun open, so
 * this is really "how long after they close the screen does the gun free up".
 */
const HOLD_MS = 60_000;

/** Mongo filter alternatives: no live hold, or the live hold is this idTag's. */
function freeOfOtherHolds(idTag: string | undefined, now: Date): Record<string, unknown>[] {
  const alternatives: Record<string, unknown>[] = [
    { hold: null },
    { 'hold.idTag': null },
    { 'hold.until': { $lt: now } },
  ];
  if (idTag) alternatives.push({ 'hold.idTag': idTag });
  return alternatives;
}

/**
 * Holds a scanned gun for this driver, or refreshes their hold. Refused
 * (false) while another driver holds it, has a start in flight on it, or is
 * charging on it — the second person to scan a sticker is then shown the gun
 * as in use instead of being able to start on top of the first.
 */
export async function holdConnector(
  chargePointId: string,
  connectorId: number,
  idTag: string,
): Promise<boolean> {
  const cp = await requireChargePoint(chargePointId);
  const now = new Date();
  const staleBefore = new Date(now.getTime() - PENDING_START_STALE_MS);

  const doc = await Connector.findOne({ chargePointId: cp._id, connectorId })
    .select('currentTransactionId')
    .lean<{ currentTransactionId?: number | null }>();
  if (!doc) return false;
  if (doc.currentTransactionId != null) {
    // Their own running session is not "someone else's".
    const tx = await Transaction.findById(doc.currentTransactionId)
      .select('idTag status')
      .lean<{ idTag?: string; status?: string }>();
    if (tx && tx.status === 'Active' && tx.idTag !== idTag) return false;
  }

  const held = await Connector.findOneAndUpdate(
    {
      chargePointId: cp._id,
      connectorId,
      $and: [
        { $or: freeOfOtherHolds(idTag, now) },
        {
          $or: [
            { pendingStart: null },
            { 'pendingStart.idTag': idTag },
            { 'pendingStart.at': { $lt: staleBefore } },
          ],
        },
      ],
    },
    { $set: { hold: { idTag, until: new Date(now.getTime() + HOLD_MS) } } },
  );
  return held !== null;
}

/** Lets go of this driver's hold, e.g. when they choose to scan another gun. */
export async function releaseConnectorHold(
  chargePointId: string,
  connectorId: number,
  idTag: string,
): Promise<void> {
  const cp = await findChargePoint(chargePointId);
  if (!cp) return;
  await Connector.updateOne(
    { chargePointId: cp._id, connectorId, 'hold.idTag': idTag },
    { $set: { hold: null } },
  );
}

/**
 * Which of a station's guns are taken by a driver other than `idTag` (a
 * signed-out viewer counts every taker as "other"): a live scan hold, a start
 * in flight, or a running session.
 */
export async function connectorsInUseByOthers(
  chargePointId: string,
  idTag: string | undefined,
): Promise<Set<number>> {
  const cp = await findChargePoint(chargePointId);
  const taken = new Set<number>();
  if (!cp) return taken;

  const now = Date.now();
  const rows = await Connector.find({ chargePointId: cp._id, connectorId: { $gt: 0 } })
    .select('connectorId hold pendingStart currentTransactionId')
    .lean<
      {
        connectorId: number;
        hold?: { idTag?: string | null; until?: Date | null } | null;
        pendingStart?: { idTag?: string | null; at?: Date | null } | null;
        currentTransactionId?: number | null;
      }[]
    >();

  const txIds = rows
    .map((r) => r.currentTransactionId)
    .filter((id): id is number => typeof id === 'number');
  const txOwners = new Map<number, string | undefined>();
  if (txIds.length > 0) {
    const txs = await Transaction.find({ _id: { $in: txIds }, status: 'Active' })
      .select('_id idTag')
      .lean<{ _id: number; idTag?: string }[]>();
    for (const tx of txs) txOwners.set(tx._id, tx.idTag);
  }

  for (const r of rows) {
    const holdLive = r.hold?.idTag && r.hold.until && r.hold.until.getTime() > now;
    const startLive =
      r.pendingStart?.idTag &&
      r.pendingStart.at &&
      r.pendingStart.at.getTime() > now - PENDING_START_STALE_MS;
    const txOwner =
      r.currentTransactionId != null && txOwners.has(r.currentTransactionId)
        ? (txOwners.get(r.currentTransactionId) ?? '')
        : undefined;

    if (
      (holdLive && r.hold!.idTag !== idTag) ||
      (startLive && r.pendingStart!.idTag !== idTag) ||
      (txOwner !== undefined && txOwner !== idTag)
    ) {
      taken.add(r.connectorId);
    }
  }
  return taken;
}

/** A connector a new session can start on right now. */
async function startable(
  c: { chargePointId: unknown; connectorId: number; status?: string; availability?: string },
  idTag: string,
): Promise<boolean> {
  if (c.availability === 'Inoperative') return false;
  const status = c.status ?? 'Available';
  if (status === 'Available' || status === 'Preparing') return true;
  if (status === 'Reserved') {
    return Boolean(
      await Reservation.exists({
        chargePointId: c.chargePointId,
        connectorId: c.connectorId,
        state: 'Active',
        idTag,
      }),
    );
  }
  return false;
}

/**
 * Ask the station to start. Everything the driver can be told up front is
 * checked here, so a start that cannot run is refused with the reason instead
 * of being reported as "Accepted" and then silently rejected by the station.
 */
export async function remoteStart(
  chargePointId: string,
  idTag: string,
  connectorId: number | undefined,
  issuedBy: string,
): Promise<{ status: string }> {
  const cp = await requireChargePoint(chargePointId);
  if (!(await IdTag.exists({ _id: idTag }))) {
    throw badRequest(`Unknown idTag "${idTag}"`);
  }
  if (!connectionManager.isOnline(cp.cpId)) {
    throw new DriverError(503, 'Станц холбогдохгүй байна. Түр хүлээгээд дахин оролдоно уу.');
  }
  if (await Transaction.exists({ idTag, status: 'Active' })) {
    throw new DriverError(409, 'Танд цэнэглэлт явж байна. Эхлээд дуусгана уу.');
  }
  if (env.WALLET_ENABLED) {
    const isInternal = await isInternalTag(idTag);
    if (!isInternal) {
      const funds = await hasBalanceToStart(idTag);
      if (!funds.ok) {
        throw new DriverError(
          402,
          `Үлдэгдэл хүрэхгүй байна. Хамгийн багадаа ${funds.required.toLocaleString('mn-MN')}₮ хэрэгтэй. Хэтэвчээ цэнэглэнэ үү.`,
        );
      }
    }
  }

  const connectors = await Connector.find({ chargePointId: cp._id, connectorId: { $gt: 0 } }).lean();
  if (connectorId !== undefined) {
    const target = connectors.find((c) => c.connectorId === connectorId);
    if (!target) {
      throw new DriverError(400, 'Ийм дугаартай холбогч алга.');
    }
    if (!(await startable(target, idTag))) {
      throw new DriverError(409, 'Энэ холбогч завгүй байна. Өөр холбогч сонгоно уу.');
    }

    // The QR sticker is per-connector, so two drivers can scan the same code
    // within moments of each other. `startable()` just read a status that is
    // seconds stale by nature (it only updates once the station reports
    // back) — this atomic claim is what actually stops the second scan from
    // also being sent to the station.
    if (!(await claimConnectorForStart(cp._id, connectorId, idTag))) {
      throw new DriverError(409, 'Энэ холбогчийг өөр хүн ашиглаж байна. Сул холбогчийн QR кодыг уншуулна уу.');
    }
  } else if (connectors.length > 0) {
    const free = await Promise.all(connectors.map((c) => startable(c, idTag)));
    if (!free.some(Boolean)) {
      throw new DriverError(409, 'Сул холбогч алга байна. Түр хүлээгээд дахин оролдоно уу.');
    }
  }

  try {
    const result = await sendToStation<{ status: string }>(
      cp.cpId,
      'RemoteStartTransaction',
      { idTag, ...(connectorId ? { connectorId } : {}) },
      issuedBy,
    );
    // Rejected outright: no StartTransaction is coming, so the next attempt
    // (by this driver or another) should not have to wait out the claim.
    if (connectorId !== undefined && result.status !== 'Accepted') {
      await releaseConnectorClaim(cp._id, connectorId);
    }
    // Their session now marks the gun as taken; the scan hold has done its job.
    if (connectorId !== undefined && result.status === 'Accepted') {
      await Connector.updateOne(
        { chargePointId: cp._id, connectorId, 'hold.idTag': idTag },
        { $set: { hold: null } },
      ).catch(() => undefined);
    }
    return result;
  } catch (err) {
    if (connectorId !== undefined) await releaseConnectorClaim(cp._id, connectorId);
    throw err;
  }
}

export async function remoteStop(transactionId: number, issuedBy: string): Promise<{ status: string }> {
  const tx = await Transaction.findById(transactionId);
  if (!tx) throw notFound('Transaction not found');
  if (tx.status !== 'Active') return { status: 'AlreadyStopped' };

  const cp = await requireChargePoint(String(tx.chargePointId));
  const result = await sendToStation<{ status: string }>(
    cp.cpId,
    'RemoteStopTransaction',
    { transactionId: tx._id },
    issuedBy,
  );
  if (result.status === 'Accepted') {
    tx.stoppedRemotely = true;
    await tx.save();
  }
  return { status: result.status };
}

export async function requestEBarimt(
  transactionId: number,
  options: { type?: 'B2C_RECEIPT' | 'B2B_RECEIPT'; customerTin?: string; customerNo?: string },
): Promise<ChargingSession> {
  const tx = await issueEBarimtForTransaction(transactionId, options);
  return toSession(tx.toObject() as unknown as RawTransaction);
}

/**
 * Releases the cable lock on the gun a session ran on.
 *
 * After StopTransaction the connector sits in `Finishing` with the cable still
 * latched, and on this hardware a driver has no way to free it from the unit —
 * so without this they are physically attached to the charger. Safe to call
 * when the session has already ended; that is in fact the normal case.
 */
export async function unlockSessionConnector(
  transactionId: number,
  issuedBy: string,
): Promise<{ status: string }> {
  const tx = await Transaction.findById(transactionId);
  if (!tx) throw notFound('Цэнэглэлт олдсонгүй');

  // Unlocking mid-charge would drop the contactor with current flowing. The
  // station is the final authority, but do not even ask.
  if (tx.status === 'Active') {
    throw badRequest('Эхлээд цэнэглэлтээ зогсооно уу');
  }

  const cp = await requireChargePoint(String(tx.chargePointId));
  const result = await sendToStation<{ status: string }>(
    cp.cpId,
    'UnlockConnector',
    { connectorId: tx.connectorId },
    issuedBy,
  );
  return { status: result.status };
}

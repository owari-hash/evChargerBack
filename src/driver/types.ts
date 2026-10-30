/**
 * Shapes the driver API returns. The kiosk web app and the Flutter app both
 * parse these, so a field renamed here breaks two clients at once.
 */

export const CONNECTOR_TYPES = ['Type2', 'CCS2', 'CHAdeMO', 'GBT', 'Type1', 'Schuko'] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export type ConnectorStatus =
  | 'Available'
  | 'Preparing'
  | 'Charging'
  | 'SuspendedEV'
  | 'SuspendedEVSE'
  | 'Finishing'
  | 'Reserved'
  | 'Unavailable'
  | 'Faulted';

export type StationAvailability = 'available' | 'busy' | 'offline' | 'unknown';

export interface StationConnector {
  connectorId: number;
  status: ConnectorStatus;
  errorCode: string;
  availability: 'Operative' | 'Inoperative';
  type?: ConnectorType;
  powerKw?: number;
  /** Operator's label for the physical gun, e.g. "Зүүн тал". */
  label?: string;
  currentTransactionId: number | null;
  lastPowerW?: number;
  lastSocPercent?: number;
  /** While a car charges on this gun and reports its battery: minutes to full. */
  minutesToFull?: number;
  statusTimestamp?: string;
  /**
   * Another driver has this gun: they scanned it and have it open, a start
   * for them is in flight, or their session is running on it. Set only by
   * `/stations/:id/live`, relative to whoever is asking.
   */
  inUseByOther?: boolean;
}

export interface Station {
  /** The charge point's ObjectId; survives the station being renamed. */
  id: string;
  /** The OCPP identifier operators and engineers know the station by. */
  cpId?: string;
  name: string;
  description?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  /** Per kWh as the driver pays it — Eplug's fee included. */
  tariffPerKwh?: number;
  /** The station's own tariff, before the fee. */
  baseTariffPerKwh?: number;
  /** The rate outside every time-of-day zone. */
  defaultTariffPerKwh?: number;
  /** Name of the time-of-day zone in effect right now, if one is and it is named. */
  currentTariffZoneName?: string;
  /** Time-of-day rates, sorted by start; absent when the station has one flat rate. */
  tariffZones?: DriverTariffZone[];
  /** Eplug's service fee on this station, in percent. */
  feePercent?: number;
  vendor?: string;
  model?: string;
  tags: string[];
  isOnline: boolean;
  lastSeenAt?: string;
  connectors: StationConnector[];
  totalConnectors: number;
  availableConnectors: number;
  maxPowerKw?: number;
  connectorTypes: ConnectorType[];
  availability: StationAvailability;
  /** Kilometres from the requested origin, when the query supplied one. */
  distanceKm?: number;
}

export interface EBarimtData {
  receiptId?: string;
  type: 'B2C_RECEIPT' | 'B2B_RECEIPT';
  qrData?: string;
  lottery?: string;
  merchantTin?: string;
  customerNo?: string;
  customerTin?: string;
  totalAmount: number;
  totalVAT: number;
  status: 'SUCCESS' | 'FAILED' | 'PENDING' | 'REFUNDED';
  issuedAt?: string;
  error?: string;
}

/** A time-of-day rate. Minutes are Mongolia local time since midnight. */
export interface DriverTariffZone {
  name?: string;
  startMinute: number;
  endMinute: number;
  tariffPerKwh: number;
}

export interface ChargingSession {
  /**
   * Per kWh this session is billed at: the zone in effect now while running
   * (from the zones frozen at its start), the blended rate once finished.
   */
  tariffPerKwh?: number;
  /** Running sessions: name of the time-of-day zone being billed right now. */
  tariffZoneName?: string;
  /** Live feed only: the driver is an internal user and charges free. */
  isInternal?: boolean;
  transactionId: number;
  chargePointId: string;
  stationName?: string;
  connectorId: number;
  idTag: string;
  status: 'Active' | 'Completed' | 'Rejected' | 'Refunded';
  startTimestamp: string;
  stopTimestamp?: string;
  energyKwh: number;
  /** Total paid: energyCost + feeAmount. */
  cost?: number;
  energyCost?: number;
  feeAmount?: number;
  feePercent?: number;
  lastPowerW?: number;
  lastSocPercent?: number;
  /**
   * Running sessions only: estimated minutes until the battery is full, from
   * how fast the station-reported battery % is rising. Absent when the
   * station does not report battery % or it is too early to tell.
   */
  minutesToFull?: number;
  stopReason?: string;
  /** The station could not confirm the gun was connected; nothing was charged. */
  plugError?: boolean;
  ebarimt?: EBarimtData;
  /** The receipt chosen at start; issued automatically when the session ends. */
  ebarimtRequest?: {
    type: 'B2C_RECEIPT' | 'B2B_RECEIPT';
    customerTin?: string;
    customerName?: string;
  };
}

export interface PublicUser {
  id: string;
  email?: string;
  phone?: string;
  name?: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  /** False only on accounts from before PIN sign-in that have not set one yet. */
  hasPin: boolean;
  /** The account's charge tag; absent only until one could be issued. */
  idTag?: string;
  isInternal?: boolean;
  vehicleBrand?: string;
  vehicleModel?: string;
  ebarimtCustomerNo?: string;
  /** First-run guides still to show this driver: 'app' and/or 'web'. */
  pendingGuides: string[];
  locale: string;
  createdAt: string;
  lastLoginAt?: string;
}

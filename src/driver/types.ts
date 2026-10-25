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
  statusTimestamp?: string;
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

export interface ChargingSession {
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
  stopReason?: string;
  ebarimt?: EBarimtData;
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

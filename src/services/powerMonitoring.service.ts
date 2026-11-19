import { Types } from 'mongoose';
import { ChargePoint, type ChargePointDoc } from '../models/ChargePoint';
import { Connector, type ConnectorDoc } from '../models/Connector';
import { Transaction, type TransactionDoc } from '../models/Transaction';
import { MeterValue } from '../models/MeterValue';
import { StationInputTelemetry } from '../models/StationInputTelemetry';
import { PowerAlert, type PowerAlertType, type PowerAlertSeverity } from '../models/PowerAlert';
import { connectionManager } from '../ocpp/manager';
import { bus } from '../realtime/events';

// ============================================================================
// 1. Pure Calculation Functions (Exported for Unit & Scenario Testing)
// ============================================================================

export interface StationUtilizationResult {
  actualOutputKw: number;
  configuredCapacityKw: number;
  utilizationPct: number;
  availableCapacityKw: number;
  overloadKw: number;
  isOverloaded: boolean;
  statusLevel: 'NORMAL' | 'HIGH' | 'NEAR_MAX' | 'AT_MAX' | 'OVERLOAD';
}

/**
 * Calculates station power utilization and available capacity.
 * Requirement: Available capacity must NEVER be negative.
 * If capacity is exceeded, available is 0 and overload value is returned separately.
 */
export function calculateStationUtilization(
  actualOutputKw: number,
  configuredCapacityKw: number,
  thresholds?: {
    highUtilizationPct?: number;
    overloadPct?: number;
  },
): StationUtilizationResult {
  const actual = Math.max(0, Math.round(actualOutputKw * 10) / 10);
  const capacity = Math.max(0, Math.round(configuredCapacityKw * 10) / 10);

  const utilizationPct = capacity > 0 ? Math.round(((actual / capacity) * 100) * 10) / 10 : 0;
  const availableCapacityKw = Math.max(0, Math.round((capacity - actual) * 10) / 10);
  const overloadKw = Math.max(0, Math.round((actual - capacity) * 10) / 10);
  const isOverloaded = actual > capacity;

  const highThresh = thresholds?.highUtilizationPct ?? 80;
  const overloadThresh = thresholds?.overloadPct ?? 95;

  let statusLevel: StationUtilizationResult['statusLevel'] = 'NORMAL';
  if (isOverloaded) {
    statusLevel = 'OVERLOAD';
  } else if (utilizationPct >= 100) {
    statusLevel = 'AT_MAX';
  } else if (utilizationPct >= overloadThresh) {
    statusLevel = 'NEAR_MAX';
  } else if (utilizationPct >= highThresh) {
    statusLevel = 'HIGH';
  }

  return {
    actualOutputKw: actual,
    configuredCapacityKw: capacity,
    utilizationPct,
    availableCapacityKw,
    overloadKw,
    isOverloaded,
    statusLevel,
  };
}

export interface PilePowerInput {
  connectorId: number;
  activePowerKw: number;
  ratedPowerKw: number;
  status: string;
}

export interface PowerSharingAnalysis {
  mode: string;
  activePilesCount: number;
  totalOutputKw: number;
  configuredCapacityKw: number;
  remainingCapacityKw: number;
  overloadKw: number;
  isCapacityReached: boolean;
  isThrottled: boolean;
  status: 'IDLE' | 'SINGLE_PILE' | 'EQUAL_SHARING' | 'DYNAMIC_SHARING' | 'OVERLOAD';
  allocations: {
    connectorId: number;
    activePowerKw: number;
    ratedPowerKw: number;
    sharePct: number;
    utilizationOfRatedPct: number;
  }[];
}

/**
 * Evaluates multi-pile simultaneous power sharing and distribution.
 * Distinguishes equal sharing, unequal dynamic allocation, throttling, and headroom.
 */
export function calculatePowerSharing(
  configuredCapacityKw: number,
  piles: PilePowerInput[],
): PowerSharingAnalysis {
  const capacity = Math.max(1, configuredCapacityKw);
  const activePiles = piles.filter((p) => p.status === 'Charging' || p.activePowerKw > 0);
  const totalOutputKw = Math.round(activePiles.reduce((sum, p) => sum + p.activePowerKw, 0) * 10) / 10;
  const remainingCapacityKw = Math.max(0, Math.round((capacity - totalOutputKw) * 10) / 10);
  const overloadKw = Math.max(0, Math.round((totalOutputKw - capacity) * 10) / 10);
  const isCapacityReached = totalOutputKw >= capacity * 0.98;

  let status: PowerSharingAnalysis['status'] = 'IDLE';
  let isThrottled = false;

  if (activePiles.length === 0) {
    status = 'IDLE';
  } else if (activePiles.length === 1) {
    status = 'SINGLE_PILE';
  } else if (overloadKw > 0) {
    status = 'OVERLOAD';
    isThrottled = true;
  } else {
    // Check if powers are approximately equal (within 10% or 3kW of each other)
    const powers = activePiles.map((p) => p.activePowerKw);
    const minPower = Math.min(...powers);
    const maxPower = Math.max(...powers);
    const diff = maxPower - minPower;

    if (diff <= 3 || (maxPower > 0 && diff / maxPower < 0.12)) {
      status = 'EQUAL_SHARING';
    } else {
      status = 'DYNAMIC_SHARING';
    }

    if (isCapacityReached) {
      isThrottled = true;
    }
  }

  const allocations = piles.map((p) => {
    const pPower = Math.max(0, p.activePowerKw);
    const rated = Math.max(0.1, p.ratedPowerKw);
    const sharePct = totalOutputKw > 0 ? Math.round(((pPower / totalOutputKw) * 100) * 10) / 10 : 0;
    const utilizationOfRatedPct = Math.round(((pPower / rated) * 100) * 10) / 10;
    return {
      connectorId: p.connectorId,
      activePowerKw: pPower,
      ratedPowerKw: rated,
      sharePct,
      utilizationOfRatedPct,
    };
  });

  return {
    mode: 'DYNAMIC_DEMAND',
    activePilesCount: activePiles.length,
    totalOutputKw,
    configuredCapacityKw: capacity,
    remainingCapacityKw,
    overloadKw,
    isCapacityReached,
    isThrottled,
    status,
    allocations,
  };
}

export interface ElectricalEfficiencyResult {
  inputMeterAvailable: boolean;
  incomingPowerKw: number | null;
  totalOutputKw: number;
  powerDifferenceKw: number | null;
  outputEfficiencyPct: number | null;
  status: 'NORMAL' | 'HIGH_LOSS' | 'INPUT_METER_UNAVAILABLE';
  notice: string | null;
}

/**
 * Calculates electrical power difference and conversion efficiency.
 * CRITICAL REQUIREMENT: If station input power is unavailable, DO NOT display
 * an invented loss percentage. Return inputMeterAvailable: false with clear notice.
 */
export function calculateElectricalEfficiency(
  incomingPowerKw: number | null | undefined,
  totalOutputKw: number,
  warningLossPct = 20,
): ElectricalEfficiencyResult {
  const output = Math.max(0, Math.round(totalOutputKw * 10) / 10);

  if (incomingPowerKw === null || incomingPowerKw === undefined || incomingPowerKw <= 0) {
    return {
      inputMeterAvailable: false,
      incomingPowerKw: null,
      totalOutputKw: output,
      powerDifferenceKw: null,
      outputEfficiencyPct: null,
      status: 'INPUT_METER_UNAVAILABLE',
      notice: 'Station input meter not available.',
    };
  }

  const incoming = Math.max(0, Math.round(incomingPowerKw * 10) / 10);
  const differenceKw = Math.max(0, Math.round((incoming - output) * 10) / 10);
  const efficiencyPct = incoming > 0
    ? Math.min(100, Math.max(0, Math.round(((output / incoming) * 100) * 10) / 10))
    : 100;

  const lossPct = 100 - efficiencyPct;
  const status = lossPct > warningLossPct ? 'HIGH_LOSS' : 'NORMAL';

  return {
    inputMeterAvailable: true,
    incomingPowerKw: incoming,
    totalOutputKw: output,
    powerDifferenceKw: differenceKw,
    outputEfficiencyPct: efficiencyPct,
    status,
    notice: null,
  };
}

export type PilePerformanceStatus =
  | 'NORMAL'
  | 'LIMITED_BY_VEHICLE'
  | 'LIMITED_BY_STATION'
  | 'LIMITED_BY_CHARGER'
  | 'UNDERPERFORMING'
  | 'POSSIBLE_ELECTRICAL_SUPPLY_ISSUE'
  | 'INSUFFICIENT_TELEMETRY'
  | 'IDLE';

export interface PilePerformanceDiagnosis {
  status: PilePerformanceStatus;
  ratedPowerKw: number;
  actualPowerKw: number;
  expectedPowerKw: number;
  utilizationOfRatedPct: number;
  explanation: string;
}

/**
 * Diagnoses charging pile performance against rated capacity and vehicle limits.
 * Requirement: NEVER classify vehicle-imposed charging limitations as charger faults!
 */
export function diagnosePilePerformance(params: {
  ratedPowerKw: number;
  activePowerKw: number;
  chargingStatus: string;
  socPercent?: number | null;
  vehicleMaxPowerKw?: number | null;
  stationThrottled?: boolean;
  voltageV?: number;
  currentA?: number;
}): PilePerformanceDiagnosis {
  const {
    ratedPowerKw,
    activePowerKw,
    chargingStatus,
    socPercent,
    vehicleMaxPowerKw,
    stationThrottled,
  } = params;

  if (chargingStatus !== 'Charging') {
    return {
      status: 'IDLE',
      ratedPowerKw,
      actualPowerKw: 0,
      expectedPowerKw: 0,
      utilizationOfRatedPct: 0,
      explanation: 'Цэнэглэлт явагдаагүй байна.',
    };
  }

  const rated = Math.max(1, ratedPowerKw);
  const actual = Math.max(0, activePowerKw);
  const utilizationOfRatedPct = Math.round(((actual / rated) * 100) * 10) / 10;

  // Compute realistic expected power based on vehicle battery state
  let expected = rated;
  if (vehicleMaxPowerKw && vehicleMaxPowerKw > 0) {
    expected = Math.min(expected, vehicleMaxPowerKw);
  }

  // Above 80% SoC, battery BMS enters Constant Voltage (CV) taper
  if (socPercent !== undefined && socPercent !== null && socPercent > 80) {
    const taperFactor = Math.max(0.15, 1 - (socPercent - 80) / 25);
    expected = Math.round(expected * taperFactor * 10) / 10;
  }

  if (actual <= 0) {
    return {
      status: 'INSUFFICIENT_TELEMETRY',
      ratedPowerKw: rated,
      actualPowerKw: 0,
      expectedPowerKw: expected,
      utilizationOfRatedPct: 0,
      explanation: 'Хүчдэл, гүйдлийн телеметрийн мэдээлэл ирээгүй байна.',
    };
  }

  // 1. Vehicle Battery BMS Limitation (SoC taper or lower vehicle intake)
  if (socPercent !== undefined && socPercent !== null && socPercent >= 80) {
    return {
      status: 'LIMITED_BY_VEHICLE',
      ratedPowerKw: rated,
      actualPowerKw: actual,
      expectedPowerKw: expected,
      utilizationOfRatedPct,
      explanation: `Батерей ${socPercent}% дүүрсэн тул машины BMS хүчдэл/гүйдлийг автоматаар бууруулж байна.`,
    };
  }

  if (vehicleMaxPowerKw && vehicleMaxPowerKw < rated && actual >= vehicleMaxPowerKw * 0.8) {
    return {
      status: 'LIMITED_BY_VEHICLE',
      ratedPowerKw: rated,
      actualPowerKw: actual,
      expectedPowerKw: expected,
      utilizationOfRatedPct,
      explanation: `Автомашины дээд хүлээж авах чадал (${vehicleMaxPowerKw} кВт) станцын хүчин чадлаас бага байна.`,
    };
  }

  // 2. Station or Grid Limit Throttling
  if (stationThrottled) {
    return {
      status: 'LIMITED_BY_STATION',
      ratedPowerKw: rated,
      actualPowerKw: actual,
      expectedPowerKw: expected,
      utilizationOfRatedPct,
      explanation: 'Станцын цахилгааны нийт дээд хязгаар эсвэл олон буу хуваарилалтаас шалтгаалан чадлыг хязгаарласан.',
    };
  }

  // 3. Significant Underperformance
  if (actual < expected * 0.5) {
    return {
      status: 'UNDERPERFORMING',
      ratedPowerKw: rated,
      actualPowerKw: actual,
      expectedPowerKw: expected,
      utilizationOfRatedPct,
      explanation: `Хүлээгдэж буй чадал (${expected} кВт)-аас мэдэгдэхүйц бага (${actual} кВт) чадал дамжуулж байна. Станцын хөргөлт, кабель эсвэл цахилгаан хангамжийг шалгана уу.`,
    };
  }

  return {
    status: 'NORMAL',
    ratedPowerKw: rated,
    actualPowerKw: actual,
    expectedPowerKw: expected,
    utilizationOfRatedPct,
    explanation: 'Цэнэглэлт хэвийн чадлын хүрээнд явагдаж байна.',
  };
}

// ============================================================================
// 2. Database Services & Aggregations
// ============================================================================

export interface PowerMonitoringSummary {
  totalStations: number;
  onlineStations: number;
  offlineStations: number;
  chargingPilesCount: number;
  activeSessionsCount: number;
  totalCurrentPowerKw: number;
  totalAvailableCapacityKw: number;
  totalStationCapacityKw: number;
  networkUtilizationPct: number;
  stationsSharingPowerCount: number;
  totalEnergyDeliveredTodayKwh: number;
  lastTelemetryTimestamp: string | null;
}

/**
 * Computes network-wide top-level KPI metrics.
 */
export async function getNetworkPowerSummary(
  clientFilter?: { clientId?: Types.ObjectId; linkedClientIds?: Types.ObjectId },
): Promise<PowerMonitoringSummary> {
  const stationFilter: Record<string, unknown> = {};
  if (clientFilter?.clientId) {
    stationFilter.$or = [
      { clientId: clientFilter.clientId },
      { linkedClientIds: clientFilter.clientId },
    ];
  }

  const [stations, connectors, activeTxList] = await Promise.all([
    ChargePoint.find(stationFilter).select('_id cpId electricalConfig isOnline lastSeenAt').lean(),
    Connector.find(
      stationFilter.$or ? { chargePointId: { $in: await getStationOids(stationFilter) } } : {},
    ).lean(),
    Transaction.find({
      status: 'Active',
      ...(stationFilter.$or ? { chargePointId: { $in: await getStationOids(stationFilter) } } : {}),
    }).lean(),
  ]);

  const totalStations = stations.length;
  let onlineStations = 0;
  let offlineStations = 0;
  let totalStationCapacityKw = 0;
  let totalCurrentPowerKw = 0;
  let chargingPilesCount = 0;
  let stationsSharingPowerCount = 0;
  let latestTelemetryTime: Date | null = null;

  const connectorsByStation = new Map<string, typeof connectors>();
  for (const c of connectors) {
    if (c.connectorId === 0) continue; // skip station-level 0
    const key = String(c.chargePointId);
    if (!connectorsByStation.has(key)) connectorsByStation.set(key, []);
    connectorsByStation.get(key)!.push(c);

    if (c.status === 'Charging') {
      chargingPilesCount++;
    }

    const pKw = (c.lastPowerW ?? 0) / 1000;
    if (pKw > 0) {
      totalCurrentPowerKw += pKw;
    }

    if (c.lastTelemetryAt && (!latestTelemetryTime || c.lastTelemetryAt > latestTelemetryTime)) {
      latestTelemetryTime = c.lastTelemetryAt;
    }
  }

  for (const st of stations) {
    const isOnline = connectionManager.isOnline(st.cpId) || Boolean(st.isOnline);
    if (isOnline) onlineStations++;
    else offlineStations++;

    const stConnectors = connectorsByStation.get(String(st._id)) ?? [];
    const sumConnectorsRated = stConnectors.reduce((sum, c) => sum + (c.powerKw ?? c.ratedPowerKw ?? 60), 0);
    const capacity = st.electricalConfig?.configuredGridLimitKW ?? st.electricalConfig?.ratedCapacityKW ?? (sumConnectorsRated || 120);
    totalStationCapacityKw += capacity;

    const activePilesAtStation = stConnectors.filter((c) => c.status === 'Charging' || (c.lastPowerW ?? 0) > 1000);
    if (activePilesAtStation.length >= 2) {
      stationsSharingPowerCount++;
    }
  }

  totalCurrentPowerKw = Math.round(totalCurrentPowerKw * 10) / 10;
  totalStationCapacityKw = Math.round(totalStationCapacityKw * 10) / 10;
  const totalAvailableCapacityKw = Math.max(0, Math.round((totalStationCapacityKw - totalCurrentPowerKw) * 10) / 10);
  const networkUtilizationPct = totalStationCapacityKw > 0
    ? Math.round(((totalCurrentPowerKw / totalStationCapacityKw) * 100) * 10) / 10
    : 0;

  // Calculate energy delivered today (start of day UTC+8 / local)
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const todaySessions = await Transaction.find({
    startTimestamp: { $gte: startOfDay },
    ...(stationFilter.$or ? { chargePointId: { $in: await getStationOids(stationFilter) } } : {}),
  }).select('energyWh meterStart lastMeterWh meterStop status').lean();

  let totalEnergyTodayWh = 0;
  for (const s of todaySessions) {
    if (s.status === 'Active') {
      totalEnergyTodayWh += (s.lastMeterWh ?? s.meterStart) - s.meterStart;
    } else {
      totalEnergyTodayWh += s.energyWh ?? (s.meterStop ? s.meterStop - s.meterStart : 0);
    }
  }

  const totalEnergyDeliveredTodayKwh = Math.round((totalEnergyTodayWh / 1000) * 10) / 10;

  return {
    totalStations,
    onlineStations,
    offlineStations,
    chargingPilesCount,
    activeSessionsCount: activeTxList.length,
    totalCurrentPowerKw,
    totalAvailableCapacityKw,
    totalStationCapacityKw,
    networkUtilizationPct,
    stationsSharingPowerCount,
    totalEnergyDeliveredTodayKwh,
    lastTelemetryTimestamp: latestTelemetryTime ? latestTelemetryTime.toISOString() : null,
  };
}

async function getStationOids(filter: Record<string, unknown>): Promise<Types.ObjectId[]> {
  const list = await ChargePoint.find(filter).select('_id').lean();
  return list.map((s) => s._id);
}

export interface StationPowerListItem {
  id: string;
  cpId: string;
  name: string;
  isOnline: boolean;
  lastSeenAt: string | null;
  ratedCapacityKw: number;
  configuredGridLimitKw: number;
  actualIncomingPowerKw: number | null;
  inputMeterAvailable: boolean;
  totalOutputPowerKw: number;
  availablePowerKw: number;
  overloadKw: number;
  utilizationPct: number;
  statusLevel: 'NORMAL' | 'HIGH' | 'NEAR_MAX' | 'AT_MAX' | 'OVERLOAD';
  activePilesCount: number;
  totalPilesCount: number;
  availablePilesCount: number;
  faultyPilesCount: number;
  powerSharingStatus: 'IDLE' | 'SINGLE_PILE' | 'EQUAL_SHARING' | 'DYNAMIC_SHARING' | 'OVERLOAD';
  efficiency: ElectricalEfficiencyResult;
  activeAlertsCount: number;
  telemetryFreshness: 'LIVE' | 'STALE' | 'OFFLINE';
  lastTelemetryAt: string | null;
  connectors: {
    connectorId: number;
    code?: string;
    label?: string;
    status: string;
    powerKw: number;
    voltageV?: number;
    currentA?: number;
    socPercent?: number;
    performanceStatus: PilePerformanceStatus;
  }[];
}

/**
 * Returns detailed power monitoring list for all stations.
 */
export async function getStationPowerList(
  clientFilter?: { clientId?: Types.ObjectId; linkedClientIds?: Types.ObjectId },
  search?: string,
): Promise<StationPowerListItem[]> {
  const filter: Record<string, unknown> = {};
  if (clientFilter?.clientId) {
    filter.$or = [
      { clientId: clientFilter.clientId },
      { linkedClientIds: clientFilter.clientId },
    ];
  }
  if (search) {
    filter.$and = [
      {
        $or: [
          { cpId: { $regex: search, $options: 'i' } },
          { name: { $regex: search, $options: 'i' } },
        ],
      },
    ];
  }

  const [stations, connectors, activeAlerts, latestInputTelemetry] = await Promise.all([
    ChargePoint.find(filter).sort({ cpId: 1 }).lean(),
    Connector.find().lean(),
    PowerAlert.find({ status: { $in: ['ACTIVE', 'ACKNOWLEDGED'] } }).lean(),
    StationInputTelemetry.aggregate([
      { $sort: { timestamp: -1 } },
      { $group: { _id: '$cpId', doc: { $first: '$$ROOT' } } },
    ]),
  ]);

  const inputMap = new Map<string, typeof latestInputTelemetry[0]['doc']>();
  for (const item of latestInputTelemetry) {
    inputMap.set(item._id, item.doc);
  }

  const alertCountMap = new Map<string, number>();
  for (const a of activeAlerts) {
    alertCountMap.set(a.cpId, (alertCountMap.get(a.cpId) ?? 0) + 1);
  }

  const connectorsByStation = new Map<string, typeof connectors>();
  for (const c of connectors) {
    const key = String(c.chargePointId);
    if (!connectorsByStation.has(key)) connectorsByStation.set(key, []);
    connectorsByStation.get(key)!.push(c);
  }

  const now = Date.now();

  return stations.map((st) => {
    const isOnline = connectionManager.isOnline(st.cpId) || Boolean(st.isOnline);
    const stConnectors = (connectorsByStation.get(String(st._id)) ?? [])
      .filter((c) => c.connectorId > 0)
      .sort((a, b) => a.connectorId - b.connectorId);

    const sumConnectorRated = stConnectors.reduce((sum, c) => sum + (c.powerKw ?? c.ratedPowerKw ?? 60), 0);
    const ratedCapacityKw = st.electricalConfig?.ratedCapacityKW ?? (sumConnectorRated || 120);
    const configuredGridLimitKw = st.electricalConfig?.configuredGridLimitKW ?? ratedCapacityKw;

    let totalOutputPowerKw = 0;
    let activePilesCount = 0;
    let availablePilesCount = 0;
    let faultyPilesCount = 0;
    let mostRecentTelemetry: Date | null = null;

    const pileInputs: PilePowerInput[] = [];

    const mappedConnectors = stConnectors.map((c) => {
      const pKw = Math.round(((c.lastPowerW ?? 0) / 1000) * 10) / 10;
      const ratedKw = c.powerKw ?? c.ratedPowerKw ?? 60;

      if (c.status === 'Charging' || pKw > 0) {
        activePilesCount++;
        totalOutputPowerKw += pKw;
      } else if (c.status === 'Available') {
        availablePilesCount++;
      } else if (c.status === 'Faulted' || c.status === 'Unavailable') {
        faultyPilesCount++;
      }

      if (c.lastTelemetryAt) {
        if (!mostRecentTelemetry || c.lastTelemetryAt > mostRecentTelemetry) {
          mostRecentTelemetry = c.lastTelemetryAt;
        }
      }

      pileInputs.push({
        connectorId: c.connectorId,
        activePowerKw: pKw,
        ratedPowerKw: ratedKw,
        status: c.status,
      });

      const performance = diagnosePilePerformance({
        ratedPowerKw: ratedKw,
        activePowerKw: pKw,
        chargingStatus: c.status,
        socPercent: c.lastSocPercent,
        voltageV: c.lastVoltageV ?? undefined,
        currentA: c.lastCurrentA ?? undefined,
      });

      return {
        connectorId: c.connectorId,
        code: c.code ?? undefined,
        label: c.label ?? undefined,
        status: c.status,
        powerKw: pKw,
        voltageV: c.lastVoltageV ?? undefined,
        currentA: c.lastCurrentA ?? undefined,
        socPercent: c.lastSocPercent ?? undefined,
        performanceStatus: performance.status,
      };
    });

    totalOutputPowerKw = Math.round(totalOutputPowerKw * 10) / 10;

    const util = calculateStationUtilization(
      totalOutputPowerKw,
      configuredGridLimitKw,
      st.electricalConfig?.warningThresholds ?? undefined,
    );

    const sharing = calculatePowerSharing(configuredGridLimitKw, pileInputs);

    // Upstream input telemetry check
    const inputTelemetry = inputMap.get(st.cpId);
    const hasInputMeter = Boolean(st.electricalConfig?.inputMeterAvailable || inputTelemetry);
    const incomingPowerKw = inputTelemetry ? inputTelemetry.inputPowerKW : null;

    const efficiency = calculateElectricalEfficiency(
      hasInputMeter ? incomingPowerKw : null,
      totalOutputPowerKw,
    );

    const lastTelemetryDate = mostRecentTelemetry as Date | null;
    let telemetryFreshness: 'LIVE' | 'STALE' | 'OFFLINE' = 'OFFLINE';
    if (isOnline) {
      if (lastTelemetryDate && now - lastTelemetryDate.getTime() < 45_000) {
        telemetryFreshness = 'LIVE';
      } else {
        telemetryFreshness = 'STALE';
      }
    }

    return {
      id: String(st._id),
      cpId: st.cpId,
      name: st.name || st.cpId,
      isOnline,
      lastSeenAt: st.lastSeenAt ? st.lastSeenAt.toISOString() : null,
      ratedCapacityKw,
      configuredGridLimitKw,
      actualIncomingPowerKw: incomingPowerKw,
      inputMeterAvailable: hasInputMeter,
      totalOutputPowerKw,
      availablePowerKw: util.availableCapacityKw,
      overloadKw: util.overloadKw,
      utilizationPct: util.utilizationPct,
      statusLevel: util.statusLevel,
      activePilesCount,
      totalPilesCount: stConnectors.length,
      availablePilesCount,
      faultyPilesCount,
      powerSharingStatus: sharing.status,
      efficiency,
      activeAlertsCount: alertCountMap.get(st.cpId) ?? 0,
      telemetryFreshness,
      lastTelemetryAt: lastTelemetryDate ? lastTelemetryDate.toISOString() : null,
      connectors: mappedConnectors,
    };
  });
}

/**
 * Returns full drill-down data for a single station.
 */
export async function getStationPowerDetail(
  chargePointRef: string,
  clientFilter?: { clientId?: Types.ObjectId; linkedClientIds?: Types.ObjectId },
) {
  let filter: Record<string, unknown>;
  if (Types.ObjectId.isValid(chargePointRef)) {
    filter = { _id: new Types.ObjectId(chargePointRef) };
  } else {
    filter = { cpId: chargePointRef };
  }
  if (clientFilter?.clientId) {
    filter.$or = [
      { clientId: clientFilter.clientId },
      { linkedClientIds: clientFilter.clientId },
    ];
  }

  const station = await ChargePoint.findOne(filter).lean();
  if (!station) return null;

  const [connectors, activeTxList, activeAlerts, inputTelemetry] = await Promise.all([
    Connector.find({ chargePointId: station._id, connectorId: { $gt: 0 } }).sort({ connectorId: 1 }).lean(),
    Transaction.find({ chargePointId: station._id, status: 'Active' }).lean(),
    PowerAlert.find({ chargePointId: station._id, status: { $in: ['ACTIVE', 'ACKNOWLEDGED'] } }).lean(),
    StationInputTelemetry.findOne({ chargePointId: station._id }).sort({ timestamp: -1 }).lean(),
  ]);

  const isOnline = connectionManager.isOnline(station.cpId) || Boolean(station.isOnline);
  const sumConnectorRated = connectors.reduce((sum, c) => sum + (c.powerKw ?? c.ratedPowerKw ?? 60), 0);
  const ratedCapacityKw = station.electricalConfig?.ratedCapacityKW ?? (sumConnectorRated || 120);
  const configuredGridLimitKw = station.electricalConfig?.configuredGridLimitKW ?? ratedCapacityKw;

  const txByConnector = new Map<number, typeof activeTxList[0]>();
  for (const tx of activeTxList) {
    txByConnector.set(tx.connectorId, tx);
  }

  let totalOutputPowerKw = 0;
  const pileInputs: PilePowerInput[] = [];

  const piles = connectors.map((c) => {
    const pKw = Math.round(((c.lastPowerW ?? 0) / 1000) * 10) / 10;
    const ratedKw = c.powerKw ?? c.ratedPowerKw ?? 60;
    const tx = txByConnector.get(c.connectorId);

    if (c.status === 'Charging' || pKw > 0) {
      totalOutputPowerKw += pKw;
    }

    pileInputs.push({
      connectorId: c.connectorId,
      activePowerKw: pKw,
      ratedPowerKw: ratedKw,
      status: c.status,
    });

    // Derive voltage and current if missing but power is present
    let voltage = c.lastVoltageV;
    let current = c.lastCurrentA;
    if ((!voltage || voltage <= 0) && pKw > 0) {
      voltage = 750; // standard DC bus estimate
    }
    if ((!current || current <= 0) && pKw > 0 && voltage && voltage > 0) {
      current = Math.round(((pKw * 1000) / voltage) * 10) / 10;
    }

    const diagnosis = diagnosePilePerformance({
      ratedPowerKw: ratedKw,
      activePowerKw: pKw,
      chargingStatus: c.status,
      socPercent: c.lastSocPercent ?? tx?.lastSocPercent,
      vehicleMaxPowerKw: tx?.vehicleData?.maxPowerKw,
      voltageV: voltage ?? undefined,
      currentA: current ?? undefined,
    });

    const sessionDurationSec = tx?.startTimestamp
      ? Math.max(0, Math.floor((Date.now() - new Date(tx.startTimestamp).getTime()) / 1000))
      : 0;

    const deliveredEnergyKwh = tx
      ? Math.round((((tx.lastMeterWh ?? tx.meterStart) - tx.meterStart) / 1000) * 10) / 10
      : (c.lastMeterWh ? Math.round((c.lastMeterWh / 1000) * 10) / 10 : 0);

    return {
      connectorId: c.connectorId,
      code: c.code ?? undefined,
      label: c.label ?? undefined,
      status: c.status,
      ratedPowerKw: ratedKw,
      maximumPowerKw: c.maximumPowerKw ?? ratedKw,
      configuredPowerLimitKw: c.configuredPowerLimitKw ?? ratedKw,
      activePowerKw: pKw,
      voltageV: voltage ?? undefined,
      currentA: current ?? undefined,
      energyKwh: deliveredEnergyKwh,
      socPercent: c.lastSocPercent ?? tx?.lastSocPercent ?? null,
      sessionDurationSec,
      transactionId: tx?._id ?? null,
      vehicle: {
        vin: tx?.vehicleVin,
        model: tx?.vehicleModel,
        batteryKwh: tx?.vehicleBatteryKwh,
      },
      diagnosis,
      lastTelemetryAt: c.lastTelemetryAt ? c.lastTelemetryAt.toISOString() : null,
      qualityStatus: c.lastTelemetryQuality ?? 'GOOD',
    };
  });

  totalOutputPowerKw = Math.round(totalOutputPowerKw * 10) / 10;
  const util = calculateStationUtilization(
    totalOutputPowerKw,
    configuredGridLimitKw,
    station.electricalConfig?.warningThresholds ?? undefined,
  );
  const sharing = calculatePowerSharing(configuredGridLimitKw, pileInputs);

  const hasInputMeter = Boolean(station.electricalConfig?.inputMeterAvailable || inputTelemetry);
  const incomingPowerKw = inputTelemetry ? inputTelemetry.inputPowerKW : null;
  const efficiency = calculateElectricalEfficiency(
    hasInputMeter ? incomingPowerKw : null,
    totalOutputPowerKw,
  );

  return {
    station: {
      id: String(station._id),
      cpId: station.cpId,
      name: station.name || station.cpId,
      isOnline,
      lastSeenAt: station.lastSeenAt ? station.lastSeenAt.toISOString() : null,
      electricalConfig: station.electricalConfig ?? {
        ratedCapacityKW: ratedCapacityKw,
        configuredGridLimitKW: configuredGridLimitKw,
        inputMeterAvailable: hasInputMeter,
        powerSharingEnabled: true,
        powerSharingMode: 'DYNAMIC_DEMAND',
      },
    },
    powerMetrics: {
      ratedCapacityKw,
      configuredGridLimitKw,
      totalOutputPowerKw,
      availablePowerKw: util.availableCapacityKw,
      overloadKw: util.overloadKw,
      utilizationPct: util.utilizationPct,
      statusLevel: util.statusLevel,
    },
    powerSharing: sharing,
    efficiency,
    piles,
    alerts: activeAlerts.map((a) => ({
      id: String(a._id),
      alertType: a.alertType,
      severity: a.severity,
      title: a.title,
      message: a.message,
      firstSeenAt: a.firstSeenAt.toISOString(),
      lastSeenAt: a.lastSeenAt.toISOString(),
      status: a.status,
    })),
  };
}

/**
 * Historical power analytics time-series with smart bucketing.
 */
export async function getHistoricalPowerAnalytics(params: {
  stationRef?: string;
  range?: string; // '15m' | '1h' | '6h' | '24h' | '7d' | '30d' | 'custom'
  from?: Date;
  to?: Date;
}) {
  const { stationRef, range = '1h' } = params;

  let chargePointOid: Types.ObjectId | null = null;
  let stationCapacityKw = 120;

  if (stationRef) {
    const cp = await ChargePoint.findOne(
      Types.ObjectId.isValid(stationRef) ? { _id: new Types.ObjectId(stationRef) } : { cpId: stationRef },
    ).select('_id cpId electricalConfig').lean();
    if (cp) {
      chargePointOid = cp._id;
      stationCapacityKw = cp.electricalConfig?.configuredGridLimitKW ?? cp.electricalConfig?.ratedCapacityKW ?? 120;
    }
  }

  const now = Date.now();
  let startTime: Date;
  let endTime: Date = params.to ?? new Date();
  let bucketMinutes = 2;

  switch (range) {
    case '15m':
      startTime = new Date(now - 15 * 60 * 1000);
      bucketMinutes = 1;
      break;
    case '1h':
      startTime = new Date(now - 60 * 60 * 1000);
      bucketMinutes = 2;
      break;
    case '6h':
      startTime = new Date(now - 6 * 60 * 60 * 1000);
      bucketMinutes = 10;
      break;
    case '24h':
      startTime = new Date(now - 24 * 60 * 60 * 1000);
      bucketMinutes = 30;
      break;
    case '7d':
      startTime = new Date(now - 7 * 24 * 60 * 60 * 1000);
      bucketMinutes = 180;
      break;
    case '30d':
      startTime = new Date(now - 30 * 24 * 60 * 60 * 1000);
      bucketMinutes = 720;
      break;
    case 'custom':
      startTime = params.from ?? new Date(now - 24 * 60 * 60 * 1000);
      const spanMs = endTime.getTime() - startTime.getTime();
      bucketMinutes = Math.max(1, Math.round(spanMs / (60 * 1000 * 50)));
      break;
    default:
      startTime = new Date(now - 60 * 60 * 1000);
      bucketMinutes = 2;
  }

  const matchFilter: Record<string, unknown> = {
    timestamp: { $gte: startTime, $lte: endTime },
  };
  if (chargePointOid) {
    matchFilter.chargePointId = chargePointOid;
  }

  // Aggregate meter values in time buckets
  const bucketMs = bucketMinutes * 60 * 1000;
  const timeSeries = await MeterValue.aggregate([
    { $match: matchFilter },
    {
      $project: {
        timestamp: 1,
        connectorId: 1,
        sampledValue: 1,
        bucketTime: {
          $toDate: {
            $subtract: [
              { $toLong: '$timestamp' },
              { $mod: [{ $toLong: '$timestamp' }, bucketMs] },
            ],
          },
        },
      },
    },
    { $unwind: '$sampledValue' },
    {
      $match: {
        'sampledValue.measurand': {
          $in: ['Power.Active.Import', 'Energy.Active.Import.Register'],
        },
      },
    },
    {
      $group: {
        _id: {
          bucketTime: '$bucketTime',
          measurand: '$sampledValue.measurand',
          connectorId: '$connectorId',
        },
        avgValue: { $avg: '$sampledValue.numericValue' },
        maxValue: { $max: '$sampledValue.numericValue' },
      },
    },
    { $sort: { '_id.bucketTime': 1 } },
  ]);

  // Aggregate into final time points
  const pointsMap = new Map<number, {
    t: string;
    timestamp: string;
    stationOutputKw: number;
    stationCapacityKw: number;
    utilizationPct: number;
    energyKwh: number;
    piles: Record<string, number>;
  }>();

  for (const item of timeSeries) {
    const timeKey = new Date(item._id.bucketTime).getTime();
    if (!pointsMap.has(timeKey)) {
      pointsMap.set(timeKey, {
        t: new Date(timeKey).toLocaleTimeString('mn-MN', { hour: '2-digit', minute: '2-digit' }),
        timestamp: new Date(timeKey).toISOString(),
        stationOutputKw: 0,
        stationCapacityKw,
        utilizationPct: 0,
        energyKwh: 0,
        piles: {},
      });
    }

    const pt = pointsMap.get(timeKey)!;
    const connectorKey = `pile_${item._id.connectorId}`;

    if (item._id.measurand === 'Power.Active.Import') {
      const valW = item.avgValue ?? 0;
      const valKw = Math.round((valW / 1000) * 10) / 10;
      pt.piles[connectorKey] = (pt.piles[connectorKey] ?? 0) + valKw;
      pt.stationOutputKw = Math.round((pt.stationOutputKw + valKw) * 10) / 10;
      pt.utilizationPct = stationCapacityKw > 0
        ? Math.min(100, Math.round(((pt.stationOutputKw / stationCapacityKw) * 100) * 10) / 10)
        : 0;
    } else if (item._id.measurand === 'Energy.Active.Import.Register') {
      const valWh = item.maxValue ?? 0;
      pt.energyKwh = Math.max(pt.energyKwh, Math.round((valWh / 1000) * 10) / 10);
    }
  }

  const resultPoints = Array.from(pointsMap.values()).sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  return {
    range,
    bucketMinutes,
    stationCapacityKw,
    points: resultPoints,
  };
}

/**
 * Evaluates telemetry for anomalies and records PowerAlerts.
 */
export async function evaluateTelemetryAlerts(params: {
  chargePointId: Types.ObjectId;
  cpId: string;
  connectorId: number;
  activePowerKw: number;
  voltageV?: number;
  currentA?: number;
  timestamp: Date;
}): Promise<void> {
  const { chargePointId, cpId, connectorId, activePowerKw, voltageV, currentA, timestamp } = params;

  const cp = await ChargePoint.findById(chargePointId).select('electricalConfig').lean();
  const cfg = cp?.electricalConfig;
  const thresholds = cfg?.warningThresholds;

  const minV = thresholds?.minVoltageV ?? 320;
  const maxV = thresholds?.maxVoltageV ?? 850;
  const maxA = thresholds?.maxCurrentA ?? 250;
  const limitKw = cfg?.configuredGridLimitKW ?? cfg?.ratedCapacityKW ?? 120;

  // 1. Voltage out of range alert
  if (voltageV && (voltageV < minV || voltageV > maxV)) {
    await raiseOrRefreshAlert({
      chargePointId,
      cpId,
      connectorId,
      alertType: 'VOLTAGE_OUT_OF_RANGE',
      severity: 'WARNING',
      title: `Хүчдэлийн хэлбэлзэл: ${voltageV}V`,
      message: `Станцын хүчдэл зөвшөөрөгдөх хэмжээнээс (${minV}V - ${maxV}V) гажсан байна.`,
      measuredValues: { voltageV, minV, maxV },
      timestamp,
    });
  }

  // 2. Current out of range alert
  if (currentA && currentA > maxA) {
    await raiseOrRefreshAlert({
      chargePointId,
      cpId,
      connectorId,
      alertType: 'CURRENT_OUT_OF_RANGE',
      severity: 'WARNING',
      title: `Гүйдэл хэтэрсэн: ${currentA}A`,
      message: `Гүйдлийн хэмжээ дээд хязгаар (${maxA}A)-аас давсан байна.`,
      measuredValues: { currentA, maxA },
      timestamp,
    });
  }

  // 3. Station Capacity Exceeded
  if (connectorId > 0 && activePowerKw > 0) {
    const connectors = await Connector.find({ chargePointId, connectorId: { $gt: 0 } }).lean();
    const totalStationPower = connectors.reduce((sum, c) => sum + (c.lastPowerW ?? 0) / 1000, 0);

    if (totalStationPower > limitKw) {
      await raiseOrRefreshAlert({
        chargePointId,
        cpId,
        alertType: 'CAPACITY_EXCEEDED',
        severity: 'CRITICAL',
        title: `Хүчин чадал хэтэрсэн: ${Math.round(totalStationPower)} кВт / ${limitKw} кВт`,
        message: `Станцын нийт чадлын хэрэглээ тохируулсан дээд хязгаар (${limitKw} кВт)-аас ${Math.round(totalStationPower - limitKw)} кВт-аар хэтэрлээ.`,
        measuredValues: { totalStationPower, limitKw },
        timestamp,
      });
    }
  }
}

async function raiseOrRefreshAlert(data: {
  chargePointId: Types.ObjectId;
  cpId: string;
  connectorId?: number;
  alertType: PowerAlertType;
  severity: PowerAlertSeverity;
  title: string;
  message: string;
  measuredValues?: Record<string, unknown>;
  timestamp: Date;
}) {
  const existing = await PowerAlert.findOne({
    cpId: data.cpId,
    alertType: data.alertType,
    status: { $in: ['ACTIVE', 'ACKNOWLEDGED'] },
  });

  if (existing) {
    existing.lastSeenAt = data.timestamp;
    existing.measuredValues = data.measuredValues;
    await existing.save();
  } else {
    const newAlert = await PowerAlert.create({
      chargePointId: data.chargePointId,
      cpId: data.cpId,
      connectorId: data.connectorId,
      alertType: data.alertType,
      severity: data.severity,
      title: data.title,
      message: data.message,
      status: 'ACTIVE',
      firstSeenAt: data.timestamp,
      lastSeenAt: data.timestamp,
      measuredValues: data.measuredValues,
    });

    bus.emitEvent('power.alert', data.cpId, newAlert.toJSON());
  }
}

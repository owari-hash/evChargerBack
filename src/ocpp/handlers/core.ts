import type { Types } from 'mongoose';
import type { z } from 'zod';
import { env } from '../../config/env';
import { ocppLogger } from '../../lib/logger';
import { ChargePoint } from '../../models/ChargePoint';
import { Connector } from '../../models/Connector';
import { Reservation } from '../../models/Reservation';
import { Transaction } from '../../models/Transaction';
import { VehicleDetection } from '../../models/VehicleDetection';
import { bus } from '../../realtime/events';
import { authorizeIdTag } from '../../services/authorization.service';
import { storeMeterValues } from '../../services/meter.service';
import {
  closeOrphanedTransactions,
  startTransaction,
  stopTransaction,
} from '../../services/transaction.service';
import type * as core from '../schemas/core';
import type { ChargePointConnection } from '../connection';
import { ensureConnectorCode } from '../../services/connector.service';

type Req<T extends z.ZodTypeAny> = z.output<T>;

export async function onBootNotification(
  payload: Req<typeof core.BootNotificationReq>,
  conn: ChargePointConnection,
) {
  // Read before the update below overwrites it, so a changed serial is visible.
  const previous = await ChargePoint.findById(conn.ref)
    .select('chargePointSerialNumber')
    .lean();
  const previousSerial = previous?.chargePointSerialNumber?.trim();

  const cp = await ChargePoint.findByIdAndUpdate(
    conn.ref,
    {
      $set: {
        chargePointVendor: payload.chargePointVendor,
        chargePointModel: payload.chargePointModel,
        chargePointSerialNumber: payload.chargePointSerialNumber,
        chargeBoxSerialNumber: payload.chargeBoxSerialNumber,
        firmwareVersion: payload.firmwareVersion,
        iccid: payload.iccid,
        imsi: payload.imsi,
        meterType: payload.meterType,
        meterSerialNumber: payload.meterSerialNumber,
        lastBootAt: new Date(),
        lastSeenAt: new Date(),
        isOnline: true,
      },
    },
    { new: true },
  );

  // The hardware behind this identity changed: it used to report one serial and
  // now reports another. Nearly always a config cloned onto a second unit whose
  // URL was never updated — and left undetected both units share one record,
  // overwrite each other's connectors, and bill the wrong pile.
  //
  // Deliberately compared against the PREVIOUS serial rather than against the
  // cpId: an operator is free to name a station "BAGANUUR-01" instead of using
  // its serial, and that is not an error. A serial that changes under a stable
  // identity always is.
  const reported = payload.chargePointSerialNumber?.trim();
  if (reported && previousSerial && reported !== previousSerial) {
    ocppLogger.error(
      { cp: conn.cpId, previousSerial, reportedSerial: reported },
      'charge point now reports a different serial than before',
    );
    await ChargePoint.findByIdAndUpdate(conn.ref, {
      $set: {
        serialMismatch: { previousSerial, reportedSerial: reported, detectedAt: new Date() },
      },
    }).catch(() => undefined);
  } else if (cp?.serialMismatch?.reportedSerial) {
    // Back to one consistent serial; stop flagging it.
    await ChargePoint.findByIdAndUpdate(conn.ref, {
      $unset: { serialMismatch: '' },
    }).catch(() => undefined);
  }

  const status = cp?.registrationStatus ?? 'Accepted';
  const interval = cp?.heartbeatInterval || env.OCPP_HEARTBEAT_INTERVAL;

  // Connector 0 always exists; it represents the charge point itself.
  await Connector.updateOne(
    { chargePointId: conn.ref, connectorId: 0 },
    { $setOnInsert: { chargePointId: conn.ref, connectorId: 0 } },
    { upsert: true },
  ).catch(() => undefined);

  // A reboot invalidates any transaction the charge point thought was running.
  const closed = await closeOrphanedTransactions(conn.ref, conn.cpId, 'Reboot');
  if (closed > 0) {
    ocppLogger.info({ cp: conn.cpId, closed }, 'closed orphaned transactions after boot');
  }

  bus.emitEvent('chargepoint.boot', conn.cpId, { ...payload, status, interval });

  return {
    currentTime: new Date().toISOString(),
    interval,
    status,
  };
}

export async function onHeartbeat(_payload: unknown, conn: ChargePointConnection) {
  const now = new Date();
  await ChargePoint.findByIdAndUpdate(conn.ref, {
    $set: { lastHeartbeatAt: now, lastSeenAt: now, isOnline: true },
  }).catch(() => undefined);
  bus.emitEvent('chargepoint.heartbeat', conn.cpId, { at: now });
  return { currentTime: now.toISOString() };
}

export async function onAuthorize(
  payload: Req<typeof core.AuthorizeReq>,
  conn: ChargePointConnection,
) {
  // Check if idTag looks like a vehicle VIN or Autocharge token (17 chars)
  const isLikelyVin = /^[A-HJ-NPR-Z0-9]{17}$/i.test(payload.idTag.trim());
  if (isLikelyVin) {
    await VehicleDetection.create({
      cpId: conn.cpId,
      chargePointId: conn.ref,
      vin: payload.idTag.trim().toUpperCase(),
      source: 'Authorize',
      protocolMessage: 'Authorize.idTag',
      remoteAddress: (conn as unknown as { remoteAddress?: string }).remoteAddress,
      rawPayload: { idTag: payload.idTag },
      detectedAt: new Date(),
    }).catch((err) => ocppLogger.warn({ err }, 'failed to record VehicleDetection from Authorize'));
  }

  const idTagInfo = await authorizeIdTag(payload.idTag, { chargePointId: conn.ref });
  await touch(conn.ref);
  return { idTagInfo: serialiseIdTagInfo(idTagInfo) };
}

export async function onStartTransaction(
  payload: Req<typeof core.StartTransactionReq>,
  conn: ChargePointConnection,
) {
  const isLikelyVin = /^[A-HJ-NPR-Z0-9]{17}$/i.test(payload.idTag.trim());

  const { transactionId, idTagInfo } = await startTransaction({
    chargePointId: conn.ref,
    cpId: conn.cpId,
    connectorId: payload.connectorId,
    idTag: payload.idTag,
    meterStart: payload.meterStart,
    timestamp: payload.timestamp,
    reservationId: payload.reservationId,
  });

  if (isLikelyVin) {
    await VehicleDetection.create({
      cpId: conn.cpId,
      chargePointId: conn.ref,
      connectorId: payload.connectorId,
      vin: payload.idTag.trim().toUpperCase(),
      source: 'StartTransaction',
      protocolMessage: 'StartTransaction.idTag',
      transactionId,
      remoteAddress: (conn as unknown as { remoteAddress?: string }).remoteAddress,
      rawPayload: payload,
      detectedAt: new Date(),
    }).catch((err) => ocppLogger.warn({ err }, 'failed to record VehicleDetection from StartTransaction'));
  }

  await touch(conn.ref);
  return { transactionId, idTagInfo: serialiseIdTagInfo(idTagInfo) };
}

export async function onStopTransaction(
  payload: Req<typeof core.StopTransactionReq>,
  conn: ChargePointConnection,
) {
  const { idTagInfo } = await stopTransaction({
    chargePointId: conn.ref,
    cpId: conn.cpId,
    transactionId: payload.transactionId,
    meterStop: payload.meterStop,
    timestamp: payload.timestamp,
    idTag: payload.idTag,
    reason: payload.reason,
    transactionData: payload.transactionData,
  });
  await touch(conn.ref);
  return idTagInfo ? { idTagInfo: serialiseIdTagInfo(idTagInfo) } : {};
}

export async function onMeterValues(
  payload: Req<typeof core.MeterValuesReq>,
  conn: ChargePointConnection,
) {
  await storeMeterValues(
    conn.ref,
    conn.cpId,
    payload.connectorId,
    payload.transactionId,
    payload.meterValue,
  );
  await touch(conn.ref);
  return {};
}

export async function onStatusNotification(
  payload: Req<typeof core.StatusNotificationReq>,
  conn: ChargePointConnection,
) {
  const timestamp = payload.timestamp ?? new Date();

  await Connector.findOneAndUpdate(
    { chargePointId: conn.ref, connectorId: payload.connectorId },
    {
      $set: {
        status: payload.status,
        errorCode: payload.errorCode,
        info: payload.info,
        vendorId: payload.vendorId,
        vendorErrorCode: payload.vendorErrorCode,
        statusTimestamp: timestamp,
        // The station's own report is authoritative now — any remoteStart()
        // claim on this connector has either landed or been overtaken by it.
        pendingStart: null,
      },
      $setOnInsert: { chargePointId: conn.ref, connectorId: payload.connectorId },
    },
    { upsert: true, new: true },
  );

  if (payload.connectorId > 0) {
    // A connector registered by hand before the station came online already has
    // its code, and this leaves it alone — the sticker is on the charger. Only
    // a gun the station reported first gets a fresh one.
    await ensureConnectorCode(conn.ref, payload.connectorId).catch((err: unknown) => {
      ocppLogger.warn({ err, cp: conn.cpId, connectorId: payload.connectorId }, 'code mint skipped');
      return null;
    });

    const count = await Connector.countDocuments({
      chargePointId: conn.ref,
      connectorId: { $gt: 0 },
    });
    await ChargePoint.findByIdAndUpdate(conn.ref, {
      $set: { numberOfConnectors: count, lastSeenAt: new Date() },
    }).catch(() => undefined);
  }

  // A connector leaving Reserved releases its reservation.
  if (payload.status !== 'Reserved') {
    await Reservation.updateMany(
      {
        chargePointId: conn.ref,
        connectorId: payload.connectorId,
        state: 'Active',
        expiryDate: { $lte: new Date() },
      },
      { $set: { state: 'Expired' } },
    ).catch(() => undefined);
  }

  bus.emitEvent('connector.status', conn.cpId, {
    connectorId: payload.connectorId,
    status: payload.status,
    errorCode: payload.errorCode,
    info: payload.info,
    timestamp,
  });

  return {};
}

export async function onDataTransfer(
  payload: Req<typeof core.DataTransferReq>,
  conn: ChargePointConnection,
) {
  ocppLogger.info(
    {
      cp: conn.cpId,
      vendorId: payload.vendorId,
      messageId: payload.messageId,
      data: payload.data,
    },
    'DataTransfer received',
  );
  await touch(conn.ref);

  let parsed: Record<string, unknown> | null = null;
  if (payload.data) {
    try {
      parsed = JSON.parse(payload.data) as Record<string, unknown>;
    } catch {
      // not standard JSON; might be raw text, VIN, or key-value
    }
  }

  let vin: string | undefined;
  let model: string | undefined;
  let soc: number | undefined;
  let batteryKwh: number | undefined;

  if (parsed && typeof parsed === 'object') {
    for (const [k, v] of Object.entries(parsed)) {
      const lk = k.toLowerCase().replace(/[-_]/g, '');
      if (lk === 'vin' || lk === 'vehicleid' || lk === 'carvin') {
        if (typeof v === 'string' && v.trim()) vin = v.trim().toUpperCase();
      } else if (
        lk === 'model' ||
        lk === 'carmodel' ||
        lk === 'vehiclemodel' ||
        lk === 'car' ||
        lk === 'vehicle' ||
        lk === 'brand'
      ) {
        if (typeof v === 'string' && v.trim()) model = v.trim();
      } else if (lk === 'soc' || lk === 'stateofcharge') {
        const num = Number(v);
        if (!Number.isNaN(num)) soc = num;
      } else if (lk === 'battery' || lk === 'batterykwh' || lk === 'capacity' || lk === 'ratedcapacity') {
        const num = Number(v);
        if (!Number.isNaN(num)) batteryKwh = num;
      }
    }
  } else if (payload.data && typeof payload.data === 'string') {
    const raw = payload.data.trim();
    const vinMatch = raw.match(/\b([A-HJ-NPR-Z0-9]{17})\b/i);
    if (vinMatch) {
      vin = vinMatch[1].toUpperCase();
    }
  }

  const vehicleInfo = {
    vin,
    model,
    soc,
    batteryKwh,
    data: parsed || (payload.data ? { raw: payload.data } : undefined),
    receivedAt: new Date(),
  };

  // Cache on ChargePoint so upcoming transactions can inherit it
  await ChargePoint.findByIdAndUpdate(conn.ref, {
    $set: {
      lastVehicleInfo: vehicleInfo,
    },
  }).catch(() => undefined);

  // If there is an ongoing transaction on this station, attach vehicle info directly
  const activeTx = await Transaction.findOne({
    chargePointId: conn.ref,
    status: 'Active',
  }).sort({ startTimestamp: -1 });

  if (activeTx) {
    if (vin) activeTx.vehicleVin = vin;
    if (model) activeTx.vehicleModel = model;
    if (soc !== undefined) activeTx.lastSocPercent = soc;
    if (batteryKwh !== undefined) activeTx.vehicleBatteryKwh = batteryKwh;
    activeTx.vehicleData = parsed || (payload.data ? { raw: payload.data } : undefined);
    await activeTx.save().catch(() => undefined);

    ocppLogger.info(
      { cp: conn.cpId, transactionId: activeTx._id, vin, model },
      'linked vehicle info from DataTransfer to active transaction',
    );
  }

  // Always persist a dedicated record to VehicleDetection collection
  await VehicleDetection.create({
    cpId: conn.cpId,
    chargePointId: conn.ref,
    vin,
    model,
    batteryCapacity: batteryKwh,
    soc,
    source: 'DataTransfer',
    protocolMessage: `${payload.vendorId}/${payload.messageId ?? ''}`,
    transactionId: activeTx?._id,
    remoteAddress: (conn as unknown as { remoteAddress?: string }).remoteAddress,
    rawPayload: parsed || (payload.data ? { raw: payload.data } : { vendorId: payload.vendorId, messageId: payload.messageId }),
    detectedAt: new Date(),
  }).catch((err) => ocppLogger.warn({ err }, 'failed to record VehicleDetection from DataTransfer'));

  bus.emitEvent('chargepoint.datatransfer', conn.cpId, {
    vendorId: payload.vendorId,
    messageId: payload.messageId,
    data: payload.data,
    vehicle: { vin, model, soc, batteryKwh },
  });

  return { status: 'Accepted' as const };
}

// ---------------------------------------------------------------------------

async function touch(ref: Types.ObjectId): Promise<void> {
  await ChargePoint.findByIdAndUpdate(ref, {
    $set: { lastSeenAt: new Date(), isOnline: true },
  }).catch(() => undefined);
}

/** IdTagInfo carries a Date internally but must go on the wire as ISO-8601. */
export function serialiseIdTagInfo(info: {
  status: string;
  parentIdTag?: string;
  expiryDate?: Date;
}) {
  return {
    status: info.status,
    ...(info.parentIdTag ? { parentIdTag: info.parentIdTag } : {}),
    ...(info.expiryDate ? { expiryDate: info.expiryDate.toISOString() } : {}),
  };
}

export { Transaction };

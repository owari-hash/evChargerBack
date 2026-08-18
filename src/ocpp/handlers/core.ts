import type { z } from 'zod';
import { env } from '../../config/env';
import { ocppLogger } from '../../lib/logger';
import { ChargePoint } from '../../models/ChargePoint';
import { Connector } from '../../models/Connector';
import { Reservation } from '../../models/Reservation';
import { Transaction } from '../../models/Transaction';
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

type Req<T extends z.ZodTypeAny> = z.output<T>;

export async function onBootNotification(
  payload: Req<typeof core.BootNotificationReq>,
  conn: ChargePointConnection,
) {
  const cp = await ChargePoint.findByIdAndUpdate(
    conn.chargePointId,
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
      $setOnInsert: {
        _id: conn.chargePointId,
        registrationStatus: 'Accepted',
        heartbeatInterval: env.OCPP_HEARTBEAT_INTERVAL,
      },
    },
    { upsert: true, new: true },
  );

  const status = cp?.registrationStatus ?? 'Accepted';
  const interval = cp?.heartbeatInterval || env.OCPP_HEARTBEAT_INTERVAL;

  // Connector 0 always exists; it represents the charge point itself.
  await Connector.updateOne(
    { chargePointId: conn.chargePointId, connectorId: 0 },
    { $setOnInsert: { chargePointId: conn.chargePointId, connectorId: 0 } },
    { upsert: true },
  ).catch(() => undefined);

  // A reboot invalidates any transaction the charge point thought was running.
  const closed = await closeOrphanedTransactions(conn.chargePointId, 'Reboot');
  if (closed > 0) {
    ocppLogger.info({ cp: conn.chargePointId, closed }, 'closed orphaned transactions after boot');
  }

  bus.emitEvent('chargepoint.boot', conn.chargePointId, { ...payload, status, interval });

  return {
    currentTime: new Date().toISOString(),
    interval,
    status,
  };
}

export async function onHeartbeat(_payload: unknown, conn: ChargePointConnection) {
  const now = new Date();
  await ChargePoint.findByIdAndUpdate(conn.chargePointId, {
    $set: { lastHeartbeatAt: now, lastSeenAt: now, isOnline: true },
  }).catch(() => undefined);
  bus.emitEvent('chargepoint.heartbeat', conn.chargePointId, { at: now });
  return { currentTime: now.toISOString() };
}

export async function onAuthorize(
  payload: Req<typeof core.AuthorizeReq>,
  conn: ChargePointConnection,
) {
  const idTagInfo = await authorizeIdTag(payload.idTag, { chargePointId: conn.chargePointId });
  await touch(conn.chargePointId);
  return { idTagInfo: serialiseIdTagInfo(idTagInfo) };
}

export async function onStartTransaction(
  payload: Req<typeof core.StartTransactionReq>,
  conn: ChargePointConnection,
) {
  const { transactionId, idTagInfo } = await startTransaction({
    chargePointId: conn.chargePointId,
    connectorId: payload.connectorId,
    idTag: payload.idTag,
    meterStart: payload.meterStart,
    timestamp: payload.timestamp,
    reservationId: payload.reservationId,
  });
  await touch(conn.chargePointId);
  return { transactionId, idTagInfo: serialiseIdTagInfo(idTagInfo) };
}

export async function onStopTransaction(
  payload: Req<typeof core.StopTransactionReq>,
  conn: ChargePointConnection,
) {
  const { idTagInfo } = await stopTransaction({
    chargePointId: conn.chargePointId,
    transactionId: payload.transactionId,
    meterStop: payload.meterStop,
    timestamp: payload.timestamp,
    idTag: payload.idTag,
    reason: payload.reason,
    transactionData: payload.transactionData,
  });
  await touch(conn.chargePointId);
  return idTagInfo ? { idTagInfo: serialiseIdTagInfo(idTagInfo) } : {};
}

export async function onMeterValues(
  payload: Req<typeof core.MeterValuesReq>,
  conn: ChargePointConnection,
) {
  await storeMeterValues(
    conn.chargePointId,
    payload.connectorId,
    payload.transactionId,
    payload.meterValue,
  );
  await touch(conn.chargePointId);
  return {};
}

export async function onStatusNotification(
  payload: Req<typeof core.StatusNotificationReq>,
  conn: ChargePointConnection,
) {
  const timestamp = payload.timestamp ?? new Date();

  await Connector.findOneAndUpdate(
    { chargePointId: conn.chargePointId, connectorId: payload.connectorId },
    {
      $set: {
        status: payload.status,
        errorCode: payload.errorCode,
        info: payload.info,
        vendorId: payload.vendorId,
        vendorErrorCode: payload.vendorErrorCode,
        statusTimestamp: timestamp,
      },
      $setOnInsert: { chargePointId: conn.chargePointId, connectorId: payload.connectorId },
    },
    { upsert: true, new: true },
  );

  if (payload.connectorId > 0) {
    const count = await Connector.countDocuments({
      chargePointId: conn.chargePointId,
      connectorId: { $gt: 0 },
    });
    await ChargePoint.findByIdAndUpdate(conn.chargePointId, {
      $set: { numberOfConnectors: count, lastSeenAt: new Date() },
    }).catch(() => undefined);
  }

  // A connector leaving Reserved releases its reservation.
  if (payload.status !== 'Reserved') {
    await Reservation.updateMany(
      {
        chargePointId: conn.chargePointId,
        connectorId: payload.connectorId,
        state: 'Active',
        expiryDate: { $lte: new Date() },
      },
      { $set: { state: 'Expired' } },
    ).catch(() => undefined);
  }

  bus.emitEvent('connector.status', conn.chargePointId, {
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
    { cp: conn.chargePointId, vendorId: payload.vendorId, messageId: payload.messageId },
    'DataTransfer received',
  );
  await touch(conn.chargePointId);
  // No vendor extensions are implemented; report the vendor as unknown per §4.3.
  return { status: 'UnknownVendorId' as const };
}

// ---------------------------------------------------------------------------

async function touch(chargePointId: string): Promise<void> {
  await ChargePoint.findByIdAndUpdate(chargePointId, {
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

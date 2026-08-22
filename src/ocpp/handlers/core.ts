import type { Types } from 'mongoose';
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
  const idTagInfo = await authorizeIdTag(payload.idTag, { chargePointId: conn.ref });
  await touch(conn.ref);
  return { idTagInfo: serialiseIdTagInfo(idTagInfo) };
}

export async function onStartTransaction(
  payload: Req<typeof core.StartTransactionReq>,
  conn: ChargePointConnection,
) {
  const { transactionId, idTagInfo } = await startTransaction({
    chargePointId: conn.ref,
    cpId: conn.cpId,
    connectorId: payload.connectorId,
    idTag: payload.idTag,
    meterStart: payload.meterStart,
    timestamp: payload.timestamp,
    reservationId: payload.reservationId,
  });
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
      },
      $setOnInsert: { chargePointId: conn.ref, connectorId: payload.connectorId },
    },
    { upsert: true, new: true },
  );

  if (payload.connectorId > 0) {
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
    { cp: conn.cpId, vendorId: payload.vendorId, messageId: payload.messageId },
    'DataTransfer received',
  );
  await touch(conn.ref);
  // No vendor extensions are implemented; report the vendor as unknown per §4.3.
  return { status: 'UnknownVendorId' as const };
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

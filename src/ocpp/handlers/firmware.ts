import type { z } from 'zod';
import { ocppLogger } from '../../lib/logger';
import { ChargePoint } from '../../models/ChargePoint';
import { DiagnosticsJob, FirmwareJob } from '../../models/Job';
import { bus } from '../../realtime/events';
import { recordSecurityEvent } from '../../services/security.service';
import type * as profiles from '../schemas/profiles';
import type * as security from '../schemas/security';
import type { ChargePointConnection } from '../connection';

type Req<T extends z.ZodTypeAny> = z.output<T>;

/** OCPP 1.6 core FirmwareStatusNotification (no requestId). */
export async function onFirmwareStatusNotification(
  payload: Req<typeof profiles.FirmwareStatusNotificationReq>,
  conn: ChargePointConnection,
) {
  await applyFirmwareStatus(conn, payload.status, undefined);
  return {};
}

/** Security white paper 5.19 — carries a requestId and richer statuses. */
export async function onSignedFirmwareStatusNotification(
  payload: Req<typeof security.SignedFirmwareStatusNotificationReq>,
  conn: ChargePointConnection,
) {
  await applyFirmwareStatus(conn, payload.status, payload.requestId);
  return {};
}

/** Takes the connection rather than an identifier because it needs both: the
 *  reference to query and update, and the OCPP identifier to log and publish. */
async function applyFirmwareStatus(
  conn: ChargePointConnection,
  status: string,
  requestId?: number,
): Promise<void> {
  const chargePointId = conn.ref;
  const filter = requestId !== undefined ? { chargePointId, requestId } : { chargePointId };
  const job = await FirmwareJob.findOne(filter).sort({ createdAt: -1 });

  if (job) {
    job.status = status;
    job.statusHistory.push({ status, at: new Date() });
    await job.save();
  } else if (status !== 'Idle') {
    ocppLogger.debug({ cp: conn.cpId, status }, 'firmware status without a matching job');
  }

  if (status === 'Installed') {
    await ChargePoint.findByIdAndUpdate(chargePointId, {
      $unset: { firmwareVersion: '' },
    }).catch(() => undefined);
    await recordSecurityEvent(conn.cpId, 'FirmwareUpdated', `job=${job?.id ?? 'unknown'}`);
  }
  if (status === 'InvalidSignature') {
    await recordSecurityEvent(
      conn.cpId,
      'InvalidFirmwareSignature',
      `job=${job?.id ?? 'unknown'}`,
    );
  }

  bus.emitEvent('firmware.status', conn.cpId, { status, requestId, jobId: job?.id });
}

export async function onDiagnosticsStatusNotification(
  payload: Req<typeof profiles.DiagnosticsStatusNotificationReq>,
  conn: ChargePointConnection,
) {
  const job = await DiagnosticsJob.findOne({
    chargePointId: conn.ref,
    kind: 'GetDiagnostics',
  }).sort({ createdAt: -1 });

  if (job) {
    job.status = payload.status;
    job.statusHistory.push({ status: payload.status, at: new Date() });
    await job.save();
  }

  bus.emitEvent('diagnostics.status', conn.cpId, {
    status: payload.status,
    jobId: job?.id,
  });
  return {};
}

/** Security white paper 5.13 — status of a GetLog upload. */
export async function onLogStatusNotification(
  payload: Req<typeof security.LogStatusNotificationReq>,
  conn: ChargePointConnection,
) {
  const filter =
    payload.requestId !== undefined
      ? { chargePointId: conn.ref, requestId: payload.requestId }
      : { chargePointId: conn.ref, kind: 'GetLog' };

  const job = await DiagnosticsJob.findOne(filter).sort({ createdAt: -1 });
  if (job) {
    job.status = payload.status;
    job.statusHistory.push({ status: payload.status, at: new Date() });
    await job.save();
  }

  bus.emitEvent('log.status', conn.cpId, {
    status: payload.status,
    requestId: payload.requestId,
    jobId: job?.id,
  });
  return {};
}

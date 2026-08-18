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
  await applyFirmwareStatus(conn.chargePointId, payload.status, undefined);
  return {};
}

/** Security white paper 5.19 — carries a requestId and richer statuses. */
export async function onSignedFirmwareStatusNotification(
  payload: Req<typeof security.SignedFirmwareStatusNotificationReq>,
  conn: ChargePointConnection,
) {
  await applyFirmwareStatus(conn.chargePointId, payload.status, payload.requestId);
  return {};
}

async function applyFirmwareStatus(
  chargePointId: string,
  status: string,
  requestId?: number,
): Promise<void> {
  const filter = requestId !== undefined ? { chargePointId, requestId } : { chargePointId };
  const job = await FirmwareJob.findOne(filter).sort({ createdAt: -1 });

  if (job) {
    job.status = status;
    job.statusHistory.push({ status, at: new Date() });
    await job.save();
  } else if (status !== 'Idle') {
    ocppLogger.debug({ cp: chargePointId, status }, 'firmware status without a matching job');
  }

  if (status === 'Installed') {
    await ChargePoint.findByIdAndUpdate(chargePointId, {
      $unset: { firmwareVersion: '' },
    }).catch(() => undefined);
    await recordSecurityEvent(chargePointId, 'FirmwareUpdated', `job=${job?.id ?? 'unknown'}`);
  }
  if (status === 'InvalidSignature') {
    await recordSecurityEvent(
      chargePointId,
      'InvalidFirmwareSignature',
      `job=${job?.id ?? 'unknown'}`,
    );
  }

  bus.emitEvent('firmware.status', chargePointId, { status, requestId, jobId: job?.id });
}

export async function onDiagnosticsStatusNotification(
  payload: Req<typeof profiles.DiagnosticsStatusNotificationReq>,
  conn: ChargePointConnection,
) {
  const job = await DiagnosticsJob.findOne({
    chargePointId: conn.chargePointId,
    kind: 'GetDiagnostics',
  }).sort({ createdAt: -1 });

  if (job) {
    job.status = payload.status;
    job.statusHistory.push({ status: payload.status, at: new Date() });
    await job.save();
  }

  bus.emitEvent('diagnostics.status', conn.chargePointId, {
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
      ? { chargePointId: conn.chargePointId, requestId: payload.requestId }
      : { chargePointId: conn.chargePointId, kind: 'GetLog' };

  const job = await DiagnosticsJob.findOne(filter).sort({ createdAt: -1 });
  if (job) {
    job.status = payload.status;
    job.statusHistory.push({ status: payload.status, at: new Date() });
    await job.save();
  }

  bus.emitEvent('log.status', conn.chargePointId, {
    status: payload.status,
    requestId: payload.requestId,
    jobId: job?.id,
  });
  return {};
}

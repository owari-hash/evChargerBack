import type { ChargePointConnection } from '../connection';
import { OcppRpcError, RpcErrorCode } from '../types';
import * as core from './core';
import * as firmware from './firmware';
import * as security from './security';

type Handler = (payload: never, conn: ChargePointConnection) => Promise<unknown>;

/** Every action a charge point may send to this Central System. */
const HANDLERS: Record<string, Handler> = {
  // Core
  BootNotification: core.onBootNotification as Handler,
  Heartbeat: core.onHeartbeat as Handler,
  Authorize: core.onAuthorize as Handler,
  StartTransaction: core.onStartTransaction as Handler,
  StopTransaction: core.onStopTransaction as Handler,
  MeterValues: core.onMeterValues as Handler,
  StatusNotification: core.onStatusNotification as Handler,
  DataTransfer: core.onDataTransfer as Handler,

  // Firmware management / diagnostics
  FirmwareStatusNotification: firmware.onFirmwareStatusNotification as Handler,
  DiagnosticsStatusNotification: firmware.onDiagnosticsStatusNotification as Handler,

  // Security white paper
  SecurityEventNotification: security.onSecurityEventNotification as Handler,
  SignCertificate: security.onSignCertificate as Handler,
  LogStatusNotification: firmware.onLogStatusNotification as Handler,
  SignedFirmwareStatusNotification: firmware.onSignedFirmwareStatusNotification as Handler,
};

export async function handleInboundCall(
  action: string,
  payload: unknown,
  conn: ChargePointConnection,
): Promise<unknown> {
  const handler = HANDLERS[action];
  if (!handler) {
    throw new OcppRpcError(RpcErrorCode.NotImplemented, `No handler for action ${action}`);
  }
  return handler(payload as never, conn);
}

export const SUPPORTED_INBOUND_ACTIONS = Object.keys(HANDLERS);

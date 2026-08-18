/**
 * OCPP-J 1.6 RPC framing.
 *
 * CALL       [2, uniqueId, action, payload]
 * CALLRESULT [3, uniqueId, payload]
 * CALLERROR  [4, uniqueId, errorCode, errorDescription, errorDetails]
 */

export const MessageType = {
  CALL: 2,
  CALLRESULT: 3,
  CALLERROR: 4,
} as const;

export type MessageTypeId = (typeof MessageType)[keyof typeof MessageType];

export type CallFrame = [2, string, string, unknown];
export type CallResultFrame = [3, string, unknown];
export type CallErrorFrame = [4, string, string, string, unknown];
export type OcppFrame = CallFrame | CallResultFrame | CallErrorFrame;

/** RPC error codes defined by the OCPP-J specification. */
export const RpcErrorCode = {
  NotImplemented: 'NotImplemented',
  NotSupported: 'NotSupported',
  InternalError: 'InternalError',
  ProtocolError: 'ProtocolError',
  SecurityError: 'SecurityError',
  FormationViolation: 'FormationViolation',
  PropertyConstraintViolation: 'PropertyConstraintViolation',
  OccurenceConstraintViolation: 'OccurenceConstraintViolation',
  TypeConstraintViolation: 'TypeConstraintViolation',
  GenericError: 'GenericError',
} as const;

export type RpcErrorCodeType = (typeof RpcErrorCode)[keyof typeof RpcErrorCode];

export class OcppRpcError extends Error {
  constructor(
    public readonly code: RpcErrorCodeType,
    message: string,
    public readonly details: unknown = {},
  ) {
    super(message);
    this.name = 'OcppRpcError';
  }
}

export class CallTimeoutError extends Error {
  constructor(action: string, timeoutMs: number) {
    super(`No response to ${action} within ${timeoutMs}ms`);
    this.name = 'CallTimeoutError';
  }
}

/** Actions the Charge Point may send to the Central System. */
export const CP_INITIATED_ACTIONS = [
  'Authorize',
  'BootNotification',
  'DataTransfer',
  'DiagnosticsStatusNotification',
  'FirmwareStatusNotification',
  'Heartbeat',
  'MeterValues',
  'StartTransaction',
  'StatusNotification',
  'StopTransaction',
  // Security white paper additions
  'LogStatusNotification',
  'SecurityEventNotification',
  'SignCertificate',
  'SignedFirmwareStatusNotification',
] as const;
export type CpInitiatedAction = (typeof CP_INITIATED_ACTIONS)[number];

/** Actions the Central System may send to the Charge Point. */
export const CS_INITIATED_ACTIONS = [
  'CancelReservation',
  'ChangeAvailability',
  'ChangeConfiguration',
  'ClearCache',
  'ClearChargingProfile',
  'DataTransfer',
  'GetCompositeSchedule',
  'GetConfiguration',
  'GetDiagnostics',
  'GetLocalListVersion',
  'RemoteStartTransaction',
  'RemoteStopTransaction',
  'ReserveNow',
  'Reset',
  'SendLocalList',
  'SetChargingProfile',
  'TriggerMessage',
  'UnlockConnector',
  'UpdateFirmware',
  // Security white paper additions
  'CertificateSigned',
  'DeleteCertificate',
  'ExtendedTriggerMessage',
  'GetInstalledCertificateIds',
  'GetLog',
  'InstallCertificate',
  'SignedUpdateFirmware',
] as const;
export type CsInitiatedAction = (typeof CS_INITIATED_ACTIONS)[number];

export interface ConnectionContext {
  chargePointId: string;
  remoteAddress: string;
  securityProfile: number;
  protocol: string;
  connectedAt: Date;
}

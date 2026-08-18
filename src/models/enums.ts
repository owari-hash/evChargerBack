export const USER_ROLES = ['ADMIN', 'OPERATOR', 'VIEWER'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const REGISTRATION_STATUSES = ['Accepted', 'Pending', 'Rejected'] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export const CONNECTOR_STATUSES = [
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEV',
  'SuspendedEVSE',
  'Finishing',
  'Reserved',
  'Unavailable',
  'Faulted',
] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

export const CHARGE_POINT_ERROR_CODES = [
  'ConnectorLockFailure',
  'EVCommunicationError',
  'GroundFailure',
  'HighTemperature',
  'InternalError',
  'LocalListConflict',
  'NoError',
  'OtherError',
  'OverCurrentFailure',
  'OverVoltage',
  'PowerMeterFailure',
  'PowerSwitchFailure',
  'ReaderFailure',
  'ResetFailure',
  'UnderVoltage',
  'WeakSignal',
] as const;
export type ChargePointErrorCode = (typeof CHARGE_POINT_ERROR_CODES)[number];

export const AUTHORIZATION_STATUSES = [
  'Accepted',
  'Blocked',
  'Expired',
  'Invalid',
  'ConcurrentTx',
] as const;
export type AuthorizationStatus = (typeof AUTHORIZATION_STATUSES)[number];

export const STOP_REASONS = [
  'EmergencyStop',
  'EVDisconnected',
  'HardReset',
  'Local',
  'Other',
  'PowerLoss',
  'Reboot',
  'Remote',
  'SoftReset',
  'UnlockCommand',
  'DeAuthorized',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export const TRANSACTION_STATUSES = ['Active', 'Completed', 'Rejected'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const RESERVATION_STATES = ['Active', 'Used', 'Cancelled', 'Expired', 'Rejected'] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];

export const CERTIFICATE_TYPES = [
  'CentralSystemRootCertificate',
  'ManufacturerRootCertificate',
  'ChargePointCertificate',
] as const;
export type CertificateType = (typeof CERTIFICATE_TYPES)[number];

export const CSR_STATUSES = ['Pending', 'Signed', 'Rejected', 'Delivered', 'Failed'] as const;
export type CsrStatus = (typeof CSR_STATUSES)[number];

export const JOB_KINDS = [
  'UpdateFirmware',
  'SignedUpdateFirmware',
  'GetDiagnostics',
  'GetLog',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const COMMAND_STATUSES = ['Pending', 'Sent', 'Success', 'Failed', 'TimedOut'] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

export const MESSAGE_DIRECTIONS = ['IN', 'OUT'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

/**
 * Security events from the OCA white paper "Improved security for OCPP 1.6-J",
 * edition 2, section 8. `true` = critical (must be pushed to the Central System).
 */
export const SECURITY_EVENTS: Record<string, boolean> = {
  FirmwareUpdated: true,
  FailedToAuthenticateAtCentralSystem: false,
  CentralSystemFailedToAuthenticate: false,
  SettingSystemTime: true,
  StartupOfTheDevice: true,
  ResetOrReboot: true,
  SecurityLogWasCleared: true,
  ReconfigurationOfSecurityParameters: false,
  MemoryExhaustion: true,
  InvalidMessages: false,
  AttemptedReplayAttacks: true,
  TamperDetectionActivated: true,
  InvalidFirmwareSignature: true,
  InvalidFirmwareSigningCertificate: true,
  InvalidCentralSystemCertificate: true,
  InvalidChargePointCertificate: true,
  InvalidTLSVersion: true,
  InvalidTLSCipherSuite: true,
};

export function isCriticalSecurityEvent(type: string): boolean {
  return SECURITY_EVENTS[type] ?? true; // unknown events are treated as critical
}

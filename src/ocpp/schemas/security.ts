import { z } from 'zod';
import { CiString, PositiveConnectorId, DateTimeSchema } from './common';

/**
 * Messages and datatypes from the OCA white paper
 * "Improved security for OCPP 1.6-J", edition 2 (2020-03-31), sections 5 and 6.
 */

// --- 6.10 HashAlgorithmEnumType / 6.1 CertificateHashDataType --------------

export const HashAlgorithmSchema = z.enum(['SHA256', 'SHA384', 'SHA512']);

export const CertificateHashDataSchema = z.object({
  hashAlgorithm: HashAlgorithmSchema,
  issuerNameHash: CiString(128),
  issuerKeyHash: CiString(128),
  serialNumber: CiString(40),
});

// --- 6.4 CertificateUseEnumType -------------------------------------------

export const CertificateUseSchema = z.enum([
  'CentralSystemRootCertificate',
  'ManufacturerRootCertificate',
]);

// --- 5.1 / 5.2 CertificateSigned ------------------------------------------

export const CertificateSignedReq = z.object({ certificateChain: CiString(10000) });
export const CertificateSignedConf = z.object({ status: z.enum(['Accepted', 'Rejected']) });

// --- 5.3 / 5.4 DeleteCertificate ------------------------------------------

export const DeleteCertificateReq = z.object({ certificateHashData: CertificateHashDataSchema });
export const DeleteCertificateConf = z.object({
  status: z.enum(['Accepted', 'Failed', 'NotFound']),
});

// --- 5.5 / 5.6 ExtendedTriggerMessage (6.14 MessageTriggerEnumType) -------

export const MessageTriggerSchema = z.enum([
  'BootNotification',
  'LogStatusNotification',
  'FirmwareStatusNotification',
  'Heartbeat',
  'MeterValues',
  'SignChargePointCertificate',
  'StatusNotification',
]);

export const ExtendedTriggerMessageReq = z.object({
  requestedMessage: MessageTriggerSchema,
  connectorId: PositiveConnectorId.optional(),
});
export const ExtendedTriggerMessageConf = z.object({
  status: z.enum(['Accepted', 'Rejected', 'NotImplemented']),
});

// --- 5.7 / 5.8 GetInstalledCertificateIds ---------------------------------

export const GetInstalledCertificateIdsReq = z.object({ certificateType: CertificateUseSchema });
export const GetInstalledCertificateIdsConf = z.object({
  status: z.enum(['Accepted', 'NotFound']),
  certificateHashData: z.array(CertificateHashDataSchema).optional(),
});

// --- 5.9 / 5.10 GetLog (6.11 LogEnumType, 6.12 LogParametersType) ---------

export const LogTypeSchema = z.enum(['DiagnosticsLog', 'SecurityLog']);

export const LogParametersSchema = z.object({
  remoteLocation: CiString(512),
  oldestTimestamp: DateTimeSchema.optional(),
  latestTimestamp: DateTimeSchema.optional(),
});

export const GetLogReq = z.object({
  logType: LogTypeSchema,
  requestId: z.number().int(),
  retries: z.number().int().optional(),
  retryInterval: z.number().int().optional(),
  log: LogParametersSchema,
});
export const GetLogConf = z.object({
  status: z.enum(['Accepted', 'Rejected', 'AcceptedCanceled']),
  filename: CiString(255).optional(),
});

// --- 5.11 / 5.12 InstallCertificate ---------------------------------------

export const InstallCertificateReq = z.object({
  certificateType: CertificateUseSchema,
  certificate: CiString(5500),
});
export const InstallCertificateConf = z.object({
  status: z.enum(['Accepted', 'Failed', 'Rejected']),
});

// --- 5.13 / 5.14 LogStatusNotification (6.17 UploadLogStatusEnumType) -----

export const UploadLogStatusSchema = z.enum([
  'BadMessage',
  'Idle',
  'NotSupportedOperation',
  'PermissionDenied',
  'Uploaded',
  'UploadFailure',
  'Uploading',
]);

export const LogStatusNotificationReq = z.object({
  status: UploadLogStatusSchema,
  requestId: z.number().int().optional(),
});
export const LogStatusNotificationConf = z.object({});

// --- 5.15 / 5.16 SecurityEventNotification --------------------------------

export const SecurityEventNotificationReq = z.object({
  type: CiString(50),
  timestamp: DateTimeSchema,
  techInfo: CiString(255).optional(),
});
export const SecurityEventNotificationConf = z.object({});

// --- 5.17 / 5.18 SignCertificate ------------------------------------------

export const SignCertificateReq = z.object({ csr: CiString(5500) });
export const SignCertificateConf = z.object({ status: z.enum(['Accepted', 'Rejected']) });

// --- 5.19 / 5.20 SignedFirmwareStatusNotification (6.6 FirmwareStatusEnum) -

export const SignedFirmwareStatusSchema = z.enum([
  'Downloaded',
  'DownloadFailed',
  'Downloading',
  'DownloadScheduled',
  'DownloadPaused',
  'Idle',
  'InstallationFailed',
  'Installing',
  'Installed',
  'InstallRebooting',
  'InstallScheduled',
  'InstallVerificationFailed',
  'InvalidSignature',
  'SignatureVerified',
]);

export const SignedFirmwareStatusNotificationReq = z.object({
  status: SignedFirmwareStatusSchema,
  requestId: z.number().int().optional(),
});
export const SignedFirmwareStatusNotificationConf = z.object({});

// --- 5.21 / 5.22 SignedUpdateFirmware (6.7 FirmwareType) ------------------

export const FirmwareTypeSchema = z.object({
  location: CiString(512),
  retrieveDateTime: DateTimeSchema,
  installDateTime: DateTimeSchema.optional(),
  signingCertificate: CiString(5500),
  signature: CiString(800),
});

export const SignedUpdateFirmwareReq = z.object({
  retries: z.number().int().optional(),
  retryInterval: z.number().int().optional(),
  requestId: z.number().int(),
  firmware: FirmwareTypeSchema,
});
export const SignedUpdateFirmwareConf = z.object({
  status: z.enum([
    'Accepted',
    'Rejected',
    'AcceptedCanceled',
    'InvalidCertificate',
    'RevokedCertificate',
  ]),
});

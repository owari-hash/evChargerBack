import { z } from 'zod';
import {
  CiString,
  ConnectorId,
  PositiveConnectorId,
  DateTimeSchema,
  IdToken,
  IdTagInfoSchema,
  ChargePointStatusSchema,
  ChargePointErrorCodeSchema,
  MeterValueSchema,
  EmptySchema,
} from './common';

// ---------------------------------------------------------------------------
// Charge Point -> Central System
// ---------------------------------------------------------------------------

export const AuthorizeReq = z.object({ idTag: IdToken });
export const AuthorizeConf = z.object({ idTagInfo: IdTagInfoSchema });

export const BootNotificationReq = z.object({
  chargePointVendor: CiString(20),
  chargePointModel: CiString(20),
  chargePointSerialNumber: CiString(25).optional(),
  chargeBoxSerialNumber: CiString(25).optional(),
  firmwareVersion: CiString(50).optional(),
  iccid: CiString(20).optional(),
  imsi: CiString(20).optional(),
  meterType: CiString(25).optional(),
  meterSerialNumber: CiString(25).optional(),
});
export const BootNotificationConf = z.object({
  currentTime: z.string(),
  interval: z.number().int(),
  status: z.enum(['Accepted', 'Pending', 'Rejected']),
});

export const HeartbeatReq = EmptySchema;
export const HeartbeatConf = z.object({ currentTime: z.string() });

export const MeterValuesReq = z.object({
  connectorId: ConnectorId,
  transactionId: z.number().int().optional(),
  meterValue: z.array(MeterValueSchema).min(1),
});
export const MeterValuesConf = z.object({});

export const StartTransactionReq = z.object({
  connectorId: PositiveConnectorId,
  idTag: IdToken,
  meterStart: z.number().int(),
  reservationId: z.number().int().optional(),
  timestamp: DateTimeSchema,
});
export const StartTransactionConf = z.object({
  idTagInfo: IdTagInfoSchema,
  transactionId: z.number().int(),
});

export const StatusNotificationReq = z.object({
  connectorId: ConnectorId,
  errorCode: ChargePointErrorCodeSchema,
  info: CiString(50).optional(),
  status: ChargePointStatusSchema,
  timestamp: DateTimeSchema.optional(),
  vendorId: CiString(255).optional(),
  vendorErrorCode: CiString(50).optional(),
});
export const StatusNotificationConf = z.object({});

export const StopTransactionReq = z.object({
  idTag: IdToken.optional(),
  meterStop: z.number().int(),
  timestamp: DateTimeSchema,
  transactionId: z.number().int(),
  reason: z
    .enum([
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
    ])
    .optional(),
  transactionData: z.array(MeterValueSchema).optional(),
});
export const StopTransactionConf = z.object({ idTagInfo: IdTagInfoSchema.optional() });

export const DataTransferReq = z.object({
  vendorId: CiString(255),
  messageId: CiString(50).optional(),
  data: z.string().optional(),
});
export const DataTransferConf = z.object({
  status: z.enum(['Accepted', 'Rejected', 'UnknownMessageId', 'UnknownVendorId']),
  data: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Central System -> Charge Point
// ---------------------------------------------------------------------------

export const ChangeAvailabilityReq = z.object({
  connectorId: ConnectorId,
  type: z.enum(['Inoperative', 'Operative']),
});
export const ChangeAvailabilityConf = z.object({
  status: z.enum(['Accepted', 'Rejected', 'Scheduled']),
});

export const ChangeConfigurationReq = z.object({
  key: CiString(50),
  value: CiString(500),
});
export const ChangeConfigurationConf = z.object({
  status: z.enum(['Accepted', 'Rejected', 'RebootRequired', 'NotSupported']),
});

export const ClearCacheReq = z.object({});
export const ClearCacheConf = z.object({ status: z.enum(['Accepted', 'Rejected']) });

export const GetConfigurationReq = z.object({
  key: z.array(CiString(50)).optional(),
});
export const GetConfigurationConf = z.object({
  configurationKey: z
    .array(
      z.object({
        key: CiString(50),
        readonly: z.boolean(),
        value: CiString(500).optional(),
      }),
    )
    .optional(),
  unknownKey: z.array(CiString(50)).optional(),
});

export const RemoteStartTransactionReq = z.object({
  connectorId: PositiveConnectorId.optional(),
  idTag: IdToken,
  chargingProfile: z.any().optional(),
});
export const RemoteStartTransactionConf = z.object({ status: z.enum(['Accepted', 'Rejected']) });

export const RemoteStopTransactionReq = z.object({ transactionId: z.number().int() });
export const RemoteStopTransactionConf = z.object({ status: z.enum(['Accepted', 'Rejected']) });

export const ResetReq = z.object({ type: z.enum(['Hard', 'Soft']) });
export const ResetConf = z.object({ status: z.enum(['Accepted', 'Rejected']) });

export const UnlockConnectorReq = z.object({ connectorId: PositiveConnectorId });
export const UnlockConnectorConf = z.object({
  status: z.enum(['Unlocked', 'UnlockFailed', 'NotSupported']),
});

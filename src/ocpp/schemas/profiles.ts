import { z } from 'zod';
import {
  CiString,
  ConnectorId,
  PositiveConnectorId,
  DateTimeSchema,
  IdToken,
  IdTagInfoSchema,
  ChargingProfileSchema,
  ChargingRateUnitSchema,
} from './common';

// ---------------------------------------------------------------------------
// Firmware Management profile
// ---------------------------------------------------------------------------

export const GetDiagnosticsReq = z.object({
  location: CiString(512),
  retries: z.number().int().optional(),
  retryInterval: z.number().int().optional(),
  startTime: DateTimeSchema.optional(),
  stopTime: DateTimeSchema.optional(),
});
export const GetDiagnosticsConf = z.object({ fileName: CiString(255).optional() });

export const DiagnosticsStatusNotificationReq = z.object({
  status: z.enum(['Idle', 'Uploaded', 'UploadFailed', 'Uploading']),
});
export const DiagnosticsStatusNotificationConf = z.object({});

export const UpdateFirmwareReq = z.object({
  location: CiString(512),
  retries: z.number().int().optional(),
  retrieveDate: DateTimeSchema,
  retryInterval: z.number().int().optional(),
});
export const UpdateFirmwareConf = z.object({});

export const FirmwareStatusNotificationReq = z.object({
  status: z.enum([
    'Downloaded',
    'DownloadFailed',
    'Downloading',
    'Idle',
    'InstallationFailed',
    'Installing',
    'Installed',
  ]),
});
export const FirmwareStatusNotificationConf = z.object({});

// ---------------------------------------------------------------------------
// Local Auth List Management profile
// ---------------------------------------------------------------------------

export const GetLocalListVersionReq = z.object({});
export const GetLocalListVersionConf = z.object({ listVersion: z.number().int() });

export const SendLocalListReq = z.object({
  listVersion: z.number().int(),
  localAuthorizationList: z
    .array(z.object({ idTag: IdToken, idTagInfo: IdTagInfoSchema.optional() }))
    .optional(),
  updateType: z.enum(['Differential', 'Full']),
});
export const SendLocalListConf = z.object({
  status: z.enum(['Accepted', 'Failed', 'NotSupported', 'VersionMismatch']),
});

// ---------------------------------------------------------------------------
// Reservation profile
// ---------------------------------------------------------------------------

export const ReserveNowReq = z.object({
  connectorId: ConnectorId,
  expiryDate: DateTimeSchema,
  idTag: IdToken,
  parentIdTag: IdToken.optional(),
  reservationId: z.number().int(),
});
export const ReserveNowConf = z.object({
  status: z.enum(['Accepted', 'Faulted', 'Occupied', 'Rejected', 'Unavailable']),
});

export const CancelReservationReq = z.object({ reservationId: z.number().int() });
export const CancelReservationConf = z.object({ status: z.enum(['Accepted', 'Rejected']) });

// ---------------------------------------------------------------------------
// Smart Charging profile
// ---------------------------------------------------------------------------

export const SetChargingProfileReq = z.object({
  connectorId: ConnectorId,
  csChargingProfiles: ChargingProfileSchema,
});
export const SetChargingProfileConf = z.object({
  status: z.enum(['Accepted', 'Rejected', 'NotSupported']),
});

export const ClearChargingProfileReq = z.object({
  id: z.number().int().optional(),
  connectorId: ConnectorId.optional(),
  chargingProfilePurpose: z
    .enum(['ChargePointMaxProfile', 'TxDefaultProfile', 'TxProfile'])
    .optional(),
  stackLevel: z.number().int().optional(),
});
export const ClearChargingProfileConf = z.object({ status: z.enum(['Accepted', 'Unknown']) });

export const GetCompositeScheduleReq = z.object({
  connectorId: ConnectorId,
  duration: z.number().int(),
  chargingRateUnit: ChargingRateUnitSchema.optional(),
});
export const GetCompositeScheduleConf = z.object({
  status: z.enum(['Accepted', 'Rejected']),
  connectorId: ConnectorId.optional(),
  scheduleStart: z.string().optional(),
  chargingSchedule: z.any().optional(),
});

// ---------------------------------------------------------------------------
// Remote Trigger profile
// ---------------------------------------------------------------------------

export const TriggerMessageReq = z.object({
  requestedMessage: z.enum([
    'BootNotification',
    'DiagnosticsStatusNotification',
    'FirmwareStatusNotification',
    'Heartbeat',
    'MeterValues',
    'StatusNotification',
  ]),
  connectorId: PositiveConnectorId.optional(),
});
export const TriggerMessageConf = z.object({
  status: z.enum(['Accepted', 'Rejected', 'NotImplemented']),
});

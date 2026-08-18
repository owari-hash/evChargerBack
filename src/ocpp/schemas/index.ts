import { z } from 'zod';
import * as core from './core';
import * as profiles from './profiles';
import * as security from './security';

export * from './common';
export { core, profiles, security };

export interface MessageDefinition {
  req: z.ZodTypeAny;
  conf: z.ZodTypeAny;
  /** Which side may originate this action. */
  origin: 'CP' | 'CS' | 'BOTH';
}

/** Every OCPP 1.6J action supported by this Central System. */
export const MESSAGE_REGISTRY = {
  // ---- Core: Charge Point initiated ----
  Authorize: { req: core.AuthorizeReq, conf: core.AuthorizeConf, origin: 'CP' },
  BootNotification: {
    req: core.BootNotificationReq,
    conf: core.BootNotificationConf,
    origin: 'CP',
  },
  Heartbeat: { req: core.HeartbeatReq, conf: core.HeartbeatConf, origin: 'CP' },
  MeterValues: { req: core.MeterValuesReq, conf: core.MeterValuesConf, origin: 'CP' },
  StartTransaction: {
    req: core.StartTransactionReq,
    conf: core.StartTransactionConf,
    origin: 'CP',
  },
  StatusNotification: {
    req: core.StatusNotificationReq,
    conf: core.StatusNotificationConf,
    origin: 'CP',
  },
  StopTransaction: { req: core.StopTransactionReq, conf: core.StopTransactionConf, origin: 'CP' },
  DataTransfer: { req: core.DataTransferReq, conf: core.DataTransferConf, origin: 'BOTH' },

  // ---- Core: Central System initiated ----
  ChangeAvailability: {
    req: core.ChangeAvailabilityReq,
    conf: core.ChangeAvailabilityConf,
    origin: 'CS',
  },
  ChangeConfiguration: {
    req: core.ChangeConfigurationReq,
    conf: core.ChangeConfigurationConf,
    origin: 'CS',
  },
  ClearCache: { req: core.ClearCacheReq, conf: core.ClearCacheConf, origin: 'CS' },
  GetConfiguration: {
    req: core.GetConfigurationReq,
    conf: core.GetConfigurationConf,
    origin: 'CS',
  },
  RemoteStartTransaction: {
    req: core.RemoteStartTransactionReq,
    conf: core.RemoteStartTransactionConf,
    origin: 'CS',
  },
  RemoteStopTransaction: {
    req: core.RemoteStopTransactionReq,
    conf: core.RemoteStopTransactionConf,
    origin: 'CS',
  },
  Reset: { req: core.ResetReq, conf: core.ResetConf, origin: 'CS' },
  UnlockConnector: { req: core.UnlockConnectorReq, conf: core.UnlockConnectorConf, origin: 'CS' },

  // ---- Firmware Management ----
  GetDiagnostics: {
    req: profiles.GetDiagnosticsReq,
    conf: profiles.GetDiagnosticsConf,
    origin: 'CS',
  },
  DiagnosticsStatusNotification: {
    req: profiles.DiagnosticsStatusNotificationReq,
    conf: profiles.DiagnosticsStatusNotificationConf,
    origin: 'CP',
  },
  UpdateFirmware: {
    req: profiles.UpdateFirmwareReq,
    conf: profiles.UpdateFirmwareConf,
    origin: 'CS',
  },
  FirmwareStatusNotification: {
    req: profiles.FirmwareStatusNotificationReq,
    conf: profiles.FirmwareStatusNotificationConf,
    origin: 'CP',
  },

  // ---- Local Auth List Management ----
  GetLocalListVersion: {
    req: profiles.GetLocalListVersionReq,
    conf: profiles.GetLocalListVersionConf,
    origin: 'CS',
  },
  SendLocalList: { req: profiles.SendLocalListReq, conf: profiles.SendLocalListConf, origin: 'CS' },

  // ---- Reservation ----
  ReserveNow: { req: profiles.ReserveNowReq, conf: profiles.ReserveNowConf, origin: 'CS' },
  CancelReservation: {
    req: profiles.CancelReservationReq,
    conf: profiles.CancelReservationConf,
    origin: 'CS',
  },

  // ---- Smart Charging ----
  SetChargingProfile: {
    req: profiles.SetChargingProfileReq,
    conf: profiles.SetChargingProfileConf,
    origin: 'CS',
  },
  ClearChargingProfile: {
    req: profiles.ClearChargingProfileReq,
    conf: profiles.ClearChargingProfileConf,
    origin: 'CS',
  },
  GetCompositeSchedule: {
    req: profiles.GetCompositeScheduleReq,
    conf: profiles.GetCompositeScheduleConf,
    origin: 'CS',
  },

  // ---- Remote Trigger ----
  TriggerMessage: {
    req: profiles.TriggerMessageReq,
    conf: profiles.TriggerMessageConf,
    origin: 'CS',
  },

  // ---- Security white paper (edition 2) ----
  CertificateSigned: {
    req: security.CertificateSignedReq,
    conf: security.CertificateSignedConf,
    origin: 'CS',
  },
  DeleteCertificate: {
    req: security.DeleteCertificateReq,
    conf: security.DeleteCertificateConf,
    origin: 'CS',
  },
  ExtendedTriggerMessage: {
    req: security.ExtendedTriggerMessageReq,
    conf: security.ExtendedTriggerMessageConf,
    origin: 'CS',
  },
  GetInstalledCertificateIds: {
    req: security.GetInstalledCertificateIdsReq,
    conf: security.GetInstalledCertificateIdsConf,
    origin: 'CS',
  },
  GetLog: { req: security.GetLogReq, conf: security.GetLogConf, origin: 'CS' },
  InstallCertificate: {
    req: security.InstallCertificateReq,
    conf: security.InstallCertificateConf,
    origin: 'CS',
  },
  SignedUpdateFirmware: {
    req: security.SignedUpdateFirmwareReq,
    conf: security.SignedUpdateFirmwareConf,
    origin: 'CS',
  },
  LogStatusNotification: {
    req: security.LogStatusNotificationReq,
    conf: security.LogStatusNotificationConf,
    origin: 'CP',
  },
  SecurityEventNotification: {
    req: security.SecurityEventNotificationReq,
    conf: security.SecurityEventNotificationConf,
    origin: 'CP',
  },
  SignCertificate: {
    req: security.SignCertificateReq,
    conf: security.SignCertificateConf,
    origin: 'CP',
  },
  SignedFirmwareStatusNotification: {
    req: security.SignedFirmwareStatusNotificationReq,
    conf: security.SignedFirmwareStatusNotificationConf,
    origin: 'CP',
  },
} as const satisfies Record<string, MessageDefinition>;

export type OcppAction = keyof typeof MESSAGE_REGISTRY;

export function getMessageDefinition(action: string): MessageDefinition | undefined {
  return (MESSAGE_REGISTRY as Record<string, MessageDefinition>)[action];
}

export const SUPPORTED_ACTIONS = Object.keys(MESSAGE_REGISTRY) as OcppAction[];

/** Payload type of a request for a given action. */
export type RequestPayload<A extends OcppAction> = z.input<(typeof MESSAGE_REGISTRY)[A]['req']>;
/** Payload type of a response for a given action. */
export type ResponsePayload<A extends OcppAction> = z.output<(typeof MESSAGE_REGISTRY)[A]['conf']>;

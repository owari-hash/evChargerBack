import { Router, type Request } from 'express';
import { z } from 'zod';
import { badRequest, notFound } from '../../lib/errors';
import { nextSequence } from '../../lib/counters';
import { ChargingProfile } from '../../models/ChargingProfile';
import { ConfigurationKey } from '../../models/ConfigurationKey';
import { Connector } from '../../models/Connector';
import { DiagnosticsJob, FirmwareJob } from '../../models/Job';
import { IdTag, LocalAuthListEntry, LocalListVersion } from '../../models/IdTag';
import { Reservation } from '../../models/Reservation';
import { Transaction } from '../../models/Transaction';
import { Certificate } from '../../models/Security';
import { connectionManager } from '../../ocpp/manager';
import { parseCertificate } from '../../services/ca.service';
import { chargePointOf, resolveChargePointParam } from '../../lib/chargePointRef';
import { asyncHandler, requireAuth, requireOperator, validate } from '../middleware';

export const commandsRouter = Router();
commandsRouter.use(requireAuth, requireOperator);

// Every route here is scoped to one station, so `:id` is resolved once and the
// handlers below take the reference for queries and the OCPP identifier for the
// connection registry from `req.chargePoint`.
commandsRouter.param('id', resolveChargePointParam);

const issuer = (req: Request) => req.user?.email ?? 'api';

/** The charge point's `_id` — what the records reference. */
const ref = (req: Request) => chargePointOf(req)._id;

const send = <T = unknown>(req: Request, action: string, payload: unknown) =>
  connectionManager.send<T>(chargePointOf(req).cpId, action, payload, issuer(req));

// ---------------------------------------------------------------------------
// Core profile
// ---------------------------------------------------------------------------

const remoteStartSchema = z.object({
  idTag: z.string().min(1).max(20),
  connectorId: z.number().int().positive().optional(),
  chargingProfile: z.any().optional(),
});

commandsRouter.post(
  '/:id/remote-start',
  validate(remoteStartSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof remoteStartSchema>;
    if (!(await IdTag.exists({ _id: body.idTag }))) {
      throw badRequest(`Unknown idTag "${body.idTag}". Create it first via POST /api/id-tags.`);
    }
    const result = await send(req, 'RemoteStartTransaction', body);
    res.json(result);
  }),
);

const remoteStopSchema = z.object({ transactionId: z.number().int() });

commandsRouter.post(
  '/:id/remote-stop',
  validate(remoteStopSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof remoteStopSchema>;
    const tx = await Transaction.findById(body.transactionId).lean();
    if (!tx) throw notFound('Transaction not found');
    if (!ref(req).equals(tx.chargePointId)) {
      throw badRequest('Transaction does not belong to this charge point');
    }
    const result = await send(req, 'RemoteStopTransaction', body);
    if ((result as { status?: string }).status === 'Accepted') {
      await Transaction.findByIdAndUpdate(body.transactionId, { $set: { stoppedRemotely: true } });
    }
    res.json(result);
  }),
);

const resetSchema = z.object({ type: z.enum(['Hard', 'Soft']).default('Soft') });

commandsRouter.post(
  '/:id/reset',
  validate(resetSchema),
  asyncHandler(async (req, res) => {
    res.json(await send(req, 'Reset', req.body));
  }),
);

const unlockSchema = z.object({ connectorId: z.number().int().positive() });

commandsRouter.post(
  '/:id/unlock-connector',
  validate(unlockSchema),
  asyncHandler(async (req, res) => {
    res.json(await send(req, 'UnlockConnector', req.body));
  }),
);

const availabilitySchema = z.object({
  connectorId: z.number().int().min(0),
  type: z.enum(['Inoperative', 'Operative']),
});

commandsRouter.post(
  '/:id/change-availability',
  validate(availabilitySchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof availabilitySchema>;
    const result = await send<{ status: string }>(req, 'ChangeAvailability', body);
    if (result.status === 'Accepted') {
      const filter =
        body.connectorId === 0
          ? { chargePointId: ref(req) }
          : { chargePointId: ref(req), connectorId: body.connectorId };
      await Connector.updateMany(filter, { $set: { availability: body.type } });
    }
    res.json(result);
  }),
);

const changeConfigSchema = z.object({
  key: z.string().min(1).max(50),
  value: z.string().max(500),
});

commandsRouter.post(
  '/:id/change-configuration',
  validate(changeConfigSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof changeConfigSchema>;
    const result = await send<{ status: string }>(req, 'ChangeConfiguration', body);
    if (result.status === 'Accepted' || result.status === 'RebootRequired') {
      // AuthorizationKey is write-only (white paper A01.FR.11); never store its value.
      const value = body.key === 'AuthorizationKey' ? undefined : body.value;
      await ConfigurationKey.updateOne(
        { chargePointId: ref(req), key: body.key },
        { $set: { value, known: true } },
        { upsert: true },
      );
    }
    res.json(result);
  }),
);

const getConfigSchema = z.object({ key: z.array(z.string().max(50)).optional() });

commandsRouter.post(
  '/:id/get-configuration',
  validate(getConfigSchema),
  asyncHandler(async (req, res) => {
    const result = await send<{
      configurationKey?: { key: string; readonly: boolean; value?: string }[];
      unknownKey?: string[];
    }>(req, 'GetConfiguration', req.body);

    const ops = [
      ...(result.configurationKey ?? []).map((k) => ({
        updateOne: {
          filter: { chargePointId: ref(req), key: k.key },
          update: {
            $set: { value: k.value ?? null, readonly: k.readonly, known: true },
            $setOnInsert: { chargePointId: ref(req), key: k.key },
          },
          upsert: true,
        },
      })),
      ...(result.unknownKey ?? []).map((key) => ({
        updateOne: {
          filter: { chargePointId: ref(req), key },
          update: {
            $set: { known: false },
            $setOnInsert: { chargePointId: ref(req), key },
          },
          upsert: true,
        },
      })),
    ];
    if (ops.length > 0) await ConfigurationKey.bulkWrite(ops);

    res.json(result);
  }),
);

commandsRouter.post(
  '/:id/clear-cache',
  asyncHandler(async (req, res) => {
    res.json(await send(req, 'ClearCache', {}));
  }),
);

const dataTransferSchema = z.object({
  vendorId: z.string().max(255),
  messageId: z.string().max(50).optional(),
  data: z.string().optional(),
});

commandsRouter.post(
  '/:id/data-transfer',
  validate(dataTransferSchema),
  asyncHandler(async (req, res) => {
    res.json(await send(req, 'DataTransfer', req.body));
  }),
);

// ---------------------------------------------------------------------------
// Remote Trigger
// ---------------------------------------------------------------------------

const triggerSchema = z.object({
  requestedMessage: z.enum([
    'BootNotification',
    'DiagnosticsStatusNotification',
    'FirmwareStatusNotification',
    'Heartbeat',
    'MeterValues',
    'StatusNotification',
  ]),
  connectorId: z.number().int().positive().optional(),
});

commandsRouter.post(
  '/:id/trigger-message',
  validate(triggerSchema),
  asyncHandler(async (req, res) => {
    res.json(await send(req, 'TriggerMessage', req.body));
  }),
);

// ---------------------------------------------------------------------------
// Reservation
// ---------------------------------------------------------------------------

const reserveSchema = z.object({
  connectorId: z.number().int().min(0),
  idTag: z.string().min(1).max(20),
  expiryDate: z.coerce.date(),
  parentIdTag: z.string().max(20).optional(),
});

commandsRouter.post(
  '/:id/reserve-now',
  validate(reserveSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof reserveSchema>;
    if (body.expiryDate.getTime() <= Date.now()) {
      throw badRequest('expiryDate must be in the future');
    }

    const reservationId = await nextSequence('reservationId');
    const result = await send<{ status: string }>(req, 'ReserveNow', {
      connectorId: body.connectorId,
      expiryDate: body.expiryDate.toISOString(),
      idTag: body.idTag,
      parentIdTag: body.parentIdTag,
      reservationId,
    });

    await Reservation.create({
      _id: reservationId,
      chargePointId: ref(req),
      connectorId: body.connectorId,
      idTag: body.idTag,
      parentIdTag: body.parentIdTag,
      expiryDate: body.expiryDate,
      state: result.status === 'Accepted' ? 'Active' : 'Rejected',
    });

    res.json({ ...result, reservationId });
  }),
);

const cancelReservationSchema = z.object({ reservationId: z.number().int() });

commandsRouter.post(
  '/:id/cancel-reservation',
  validate(cancelReservationSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof cancelReservationSchema>;
    const result = await send<{ status: string }>(req, 'CancelReservation', body);
    if (result.status === 'Accepted') {
      await Reservation.findByIdAndUpdate(body.reservationId, { $set: { state: 'Cancelled' } });
    }
    res.json(result);
  }),
);

// ---------------------------------------------------------------------------
// Smart Charging
// ---------------------------------------------------------------------------

const chargingSchedulePeriod = z.object({
  startPeriod: z.number().int().min(0),
  limit: z.number(),
  numberPhases: z.number().int().min(1).max(3).optional(),
});

const setProfileSchema = z.object({
  connectorId: z.number().int().min(0),
  csChargingProfiles: z.object({
    chargingProfileId: z.number().int().optional(),
    transactionId: z.number().int().optional(),
    stackLevel: z.number().int().min(0),
    chargingProfilePurpose: z.enum(['ChargePointMaxProfile', 'TxDefaultProfile', 'TxProfile']),
    chargingProfileKind: z.enum(['Absolute', 'Recurring', 'Relative']),
    recurrencyKind: z.enum(['Daily', 'Weekly']).optional(),
    validFrom: z.coerce.date().optional(),
    validTo: z.coerce.date().optional(),
    chargingSchedule: z.object({
      duration: z.number().int().optional(),
      startSchedule: z.coerce.date().optional(),
      chargingRateUnit: z.enum(['A', 'W']),
      chargingSchedulePeriod: z.array(chargingSchedulePeriod).min(1),
      minChargingRate: z.number().optional(),
    }),
  }),
});

commandsRouter.post(
  '/:id/set-charging-profile',
  validate(setProfileSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof setProfileSchema>;
    const p = body.csChargingProfiles;
    const chargingProfileId = p.chargingProfileId ?? (await nextSequence('chargingProfileId'));

    const wire = {
      connectorId: body.connectorId,
      csChargingProfiles: {
        ...p,
        chargingProfileId,
        validFrom: p.validFrom?.toISOString(),
        validTo: p.validTo?.toISOString(),
        chargingSchedule: {
          ...p.chargingSchedule,
          startSchedule: p.chargingSchedule.startSchedule?.toISOString(),
        },
      },
    };

    const result = await send<{ status: string }>(req, 'SetChargingProfile', wire);

    if (result.status === 'Accepted') {
      await ChargingProfile.updateOne(
        { chargePointId: ref(req), chargingProfileId },
        {
          $set: {
            connectorId: body.connectorId,
            transactionId: p.transactionId,
            stackLevel: p.stackLevel,
            chargingProfilePurpose: p.chargingProfilePurpose,
            chargingProfileKind: p.chargingProfileKind,
            recurrencyKind: p.recurrencyKind,
            validFrom: p.validFrom,
            validTo: p.validTo,
            chargingSchedule: p.chargingSchedule,
            isActive: true,
          },
          $setOnInsert: { chargePointId: ref(req), chargingProfileId },
        },
        { upsert: true },
      );
    }

    res.json({ ...result, chargingProfileId });
  }),
);

const clearProfileSchema = z.object({
  id: z.number().int().optional(),
  connectorId: z.number().int().min(0).optional(),
  chargingProfilePurpose: z
    .enum(['ChargePointMaxProfile', 'TxDefaultProfile', 'TxProfile'])
    .optional(),
  stackLevel: z.number().int().optional(),
});

commandsRouter.post(
  '/:id/clear-charging-profile',
  validate(clearProfileSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof clearProfileSchema>;
    const result = await send<{ status: string }>(req, 'ClearChargingProfile', body);

    if (result.status === 'Accepted') {
      const filter: Record<string, unknown> = { chargePointId: ref(req) };
      if (body.id !== undefined) filter.chargingProfileId = body.id;
      if (body.connectorId !== undefined) filter.connectorId = body.connectorId;
      if (body.chargingProfilePurpose) filter.chargingProfilePurpose = body.chargingProfilePurpose;
      if (body.stackLevel !== undefined) filter.stackLevel = body.stackLevel;
      await ChargingProfile.updateMany(filter, { $set: { isActive: false } });
    }

    res.json(result);
  }),
);

const compositeScheduleSchema = z.object({
  connectorId: z.number().int().min(0),
  duration: z.number().int().positive(),
  chargingRateUnit: z.enum(['A', 'W']).optional(),
});

commandsRouter.post(
  '/:id/get-composite-schedule',
  validate(compositeScheduleSchema),
  asyncHandler(async (req, res) => {
    res.json(await send(req, 'GetCompositeSchedule', req.body));
  }),
);

// ---------------------------------------------------------------------------
// Local authorization list
// ---------------------------------------------------------------------------

commandsRouter.post(
  '/:id/get-local-list-version',
  asyncHandler(async (req, res) => {
    const result = await send<{ listVersion: number }>(req, 'GetLocalListVersion', {});
    await LocalListVersion.updateOne(
      { chargePointId: ref(req) },
      { $set: { version: result.listVersion, lastSyncedAt: new Date() } },
      { upsert: true },
    );
    res.json(result);
  }),
);

const sendLocalListSchema = z.object({
  updateType: z.enum(['Differential', 'Full']).default('Full'),
  /** When omitted, the full IdTag collection is pushed. */
  idTags: z.array(z.string().max(20)).optional(),
});

commandsRouter.post(
  '/:id/send-local-list',
  validate(sendLocalListSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof sendLocalListSchema>;
    const chargePointId = ref(req);

    const filter = body.idTags ? { _id: { $in: body.idTags } } : {};
    const tags = await IdTag.find(filter).lean();

    const listVersion = await nextSequence('localListVersion');
    const localAuthorizationList = tags.map((t) => ({
      idTag: t._id,
      idTagInfo: {
        status: t.status,
        ...(t.parentIdTag ? { parentIdTag: t.parentIdTag } : {}),
        ...(t.expiryDate ? { expiryDate: t.expiryDate.toISOString() } : {}),
      },
    }));

    const result = await send<{ status: string }>(req, 'SendLocalList', {
      listVersion,
      updateType: body.updateType,
      localAuthorizationList,
    });

    if (result.status === 'Accepted') {
      await LocalListVersion.updateOne(
        { chargePointId },
        { $set: { version: listVersion, lastSyncedAt: new Date() } },
        { upsert: true },
      );
      if (body.updateType === 'Full') {
        await LocalAuthListEntry.deleteMany({ chargePointId });
      }
      if (tags.length > 0) {
        await LocalAuthListEntry.bulkWrite(
          tags.map((t) => ({
            updateOne: {
              filter: { chargePointId, idTag: t._id },
              update: {
                $set: {
                  status: t.status,
                  parentIdTag: t.parentIdTag,
                  expiryDate: t.expiryDate,
                  listVersion,
                },
                $setOnInsert: { chargePointId, idTag: t._id },
              },
              upsert: true,
            },
          })),
        );
      }
    }

    res.json({ ...result, listVersion, entries: localAuthorizationList.length });
  }),
);

// ---------------------------------------------------------------------------
// Firmware management and diagnostics
// ---------------------------------------------------------------------------

const updateFirmwareSchema = z.object({
  location: z.string().url().max(512),
  retrieveDate: z.coerce.date(),
  retries: z.number().int().min(0).optional(),
  retryInterval: z.number().int().min(0).optional(),
});

commandsRouter.post(
  '/:id/update-firmware',
  validate(updateFirmwareSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updateFirmwareSchema>;
    const job = await FirmwareJob.create({
      chargePointId: ref(req),
      kind: 'UpdateFirmware',
      location: body.location,
      retrieveDate: body.retrieveDate,
      retries: body.retries,
      retryInterval: body.retryInterval,
      issuedBy: issuer(req),
    });

    const result = await send(req, 'UpdateFirmware', {
      location: body.location,
      retrieveDate: body.retrieveDate.toISOString(),
      retries: body.retries,
      retryInterval: body.retryInterval,
    });

    res.json({ ...(result as object), jobId: job.id });
  }),
);

const getDiagnosticsSchema = z.object({
  location: z.string().max(512),
  startTime: z.coerce.date().optional(),
  stopTime: z.coerce.date().optional(),
  retries: z.number().int().min(0).optional(),
  retryInterval: z.number().int().min(0).optional(),
});

commandsRouter.post(
  '/:id/get-diagnostics',
  validate(getDiagnosticsSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof getDiagnosticsSchema>;
    const result = await send<{ fileName?: string }>(req, 'GetDiagnostics', {
      location: body.location,
      startTime: body.startTime?.toISOString(),
      stopTime: body.stopTime?.toISOString(),
      retries: body.retries,
      retryInterval: body.retryInterval,
    });

    const job = await DiagnosticsJob.create({
      chargePointId: ref(req),
      kind: 'GetDiagnostics',
      location: body.location,
      oldestTimestamp: body.startTime,
      latestTimestamp: body.stopTime,
      retries: body.retries,
      retryInterval: body.retryInterval,
      fileName: result.fileName,
      status: result.fileName ? 'Accepted' : 'NoDataAvailable',
      issuedBy: issuer(req),
    });

    res.json({ ...result, jobId: job.id });
  }),
);

// ---------------------------------------------------------------------------
// Security white paper commands
// ---------------------------------------------------------------------------

const extendedTriggerSchema = z.object({
  requestedMessage: z.enum([
    'BootNotification',
    'LogStatusNotification',
    'FirmwareStatusNotification',
    'Heartbeat',
    'MeterValues',
    'SignChargePointCertificate',
    'StatusNotification',
  ]),
  connectorId: z.number().int().positive().optional(),
});

commandsRouter.post(
  '/:id/extended-trigger-message',
  validate(extendedTriggerSchema),
  asyncHandler(async (req, res) => {
    res.json(await send(req, 'ExtendedTriggerMessage', req.body));
  }),
);

const getLogSchema = z.object({
  logType: z.enum(['DiagnosticsLog', 'SecurityLog']),
  remoteLocation: z.string().max(512),
  oldestTimestamp: z.coerce.date().optional(),
  latestTimestamp: z.coerce.date().optional(),
  retries: z.number().int().min(0).optional(),
  retryInterval: z.number().int().min(0).optional(),
});

commandsRouter.post(
  '/:id/get-log',
  validate(getLogSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof getLogSchema>;
    const requestId = await nextSequence('requestId');

    const result = await send<{ status: string; filename?: string }>(req, 'GetLog', {
      logType: body.logType,
      requestId,
      retries: body.retries,
      retryInterval: body.retryInterval,
      log: {
        remoteLocation: body.remoteLocation,
        oldestTimestamp: body.oldestTimestamp?.toISOString(),
        latestTimestamp: body.latestTimestamp?.toISOString(),
      },
    });

    const job = await DiagnosticsJob.create({
      chargePointId: ref(req),
      kind: 'GetLog',
      requestId,
      location: body.remoteLocation,
      logType: body.logType,
      oldestTimestamp: body.oldestTimestamp,
      latestTimestamp: body.latestTimestamp,
      retries: body.retries,
      retryInterval: body.retryInterval,
      fileName: result.filename,
      status: result.status,
      issuedBy: issuer(req),
    });

    res.json({ ...result, requestId, jobId: job.id });
  }),
);

const installCertSchema = z.object({
  certificateType: z.enum(['CentralSystemRootCertificate', 'ManufacturerRootCertificate']),
  certificate: z.string().max(5500),
});

commandsRouter.post(
  '/:id/install-certificate',
  validate(installCertSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof installCertSchema>;
    const parsed = parseCertificate(body.certificate);

    const result = await send<{ status: string }>(req, 'InstallCertificate', body);

    if (result.status === 'Accepted') {
      await Certificate.create({
        chargePointId: ref(req),
        type: body.certificateType,
        pem: body.certificate,
        serialNumber: parsed.serialNumber,
        subject: parsed.subject,
        issuer: parsed.issuer,
        validFrom: parsed.validFrom,
        validTo: parsed.validTo,
        hashAlgorithm: parsed.hashAlgorithm,
        issuerNameHash: parsed.issuerNameHash,
        issuerKeyHash: parsed.issuerKeyHash,
        installedAt: new Date(),
      });
    }

    res.json(result);
  }),
);

const certTypeSchema = z.object({
  certificateType: z.enum(['CentralSystemRootCertificate', 'ManufacturerRootCertificate']),
});

commandsRouter.post(
  '/:id/get-installed-certificate-ids',
  validate(certTypeSchema),
  asyncHandler(async (req, res) => {
    res.json(await send(req, 'GetInstalledCertificateIds', req.body));
  }),
);

const deleteCertSchema = z.object({
  certificateHashData: z.object({
    hashAlgorithm: z.enum(['SHA256', 'SHA384', 'SHA512']),
    issuerNameHash: z.string().max(128),
    issuerKeyHash: z.string().max(128),
    serialNumber: z.string().max(40),
  }),
});

commandsRouter.post(
  '/:id/delete-certificate',
  validate(deleteCertSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof deleteCertSchema>;
    const result = await send<{ status: string }>(req, 'DeleteCertificate', body);
    if (result.status === 'Accepted') {
      await Certificate.updateMany(
        {
          chargePointId: ref(req),
          serialNumber: body.certificateHashData.serialNumber,
          issuerKeyHash: body.certificateHashData.issuerKeyHash,
        },
        { $set: { deletedAt: new Date() } },
      );
    }
    res.json(result);
  }),
);

const certificateSignedSchema = z.object({ certificateChain: z.string().max(10000) });

commandsRouter.post(
  '/:id/certificate-signed',
  validate(certificateSignedSchema),
  asyncHandler(async (req, res) => {
    res.json(await send(req, 'CertificateSigned', req.body));
  }),
);

const signedUpdateFirmwareSchema = z.object({
  location: z.string().url().max(512),
  retrieveDateTime: z.coerce.date(),
  installDateTime: z.coerce.date().optional(),
  signingCertificate: z.string().max(5500),
  signature: z.string().max(800),
  retries: z.number().int().min(0).optional(),
  retryInterval: z.number().int().min(0).optional(),
});

commandsRouter.post(
  '/:id/signed-update-firmware',
  validate(signedUpdateFirmwareSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof signedUpdateFirmwareSchema>;
    const requestId = await nextSequence('requestId');

    const job = await FirmwareJob.create({
      chargePointId: ref(req),
      kind: 'SignedUpdateFirmware',
      requestId,
      location: body.location,
      retrieveDate: body.retrieveDateTime,
      installDate: body.installDateTime,
      retries: body.retries,
      retryInterval: body.retryInterval,
      signature: body.signature,
      signingCertificate: body.signingCertificate,
      issuedBy: issuer(req),
    });

    const result = await send<{ status: string }>(req, 'SignedUpdateFirmware', {
      requestId,
      retries: body.retries,
      retryInterval: body.retryInterval,
      firmware: {
        location: body.location,
        retrieveDateTime: body.retrieveDateTime.toISOString(),
        installDateTime: body.installDateTime?.toISOString(),
        signingCertificate: body.signingCertificate,
        signature: body.signature,
      },
    });

    job.status = result.status;
    job.statusHistory.push({ status: result.status, at: new Date() });
    await job.save();

    res.json({ ...result, requestId, jobId: job.id });
  }),
);

// ---------------------------------------------------------------------------
// Escape hatch: send any registered OCPP action verbatim
// ---------------------------------------------------------------------------

const rawSchema = z.object({
  action: z.string().min(1),
  payload: z.record(z.any()).default({}),
});

commandsRouter.post(
  '/:id/raw',
  validate(rawSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof rawSchema>;
    res.json(await send(req, body.action, body.payload));
  }),
);

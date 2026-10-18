import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { isValidObjectId, Types } from 'mongoose';
import { z } from 'zod';
import { badRequest, notFound, conflict, forbidden } from '../../lib/errors';
import { requireChargePoint } from '../../lib/chargePointRef';
import { ChargePoint } from '../../models/ChargePoint';
import { EbarimtMerchant } from '../../models/EbarimtMerchant';
import { Client } from '../../models/Client';
import { Connector } from '../../models/Connector';
import { Transaction } from '../../models/Transaction';
import { ConfigurationKey } from '../../models/ConfigurationKey';
import { OcppMessageLog, CommandLog } from '../../models/Log';
import { REGISTRATION_STATUSES } from '../../models/enums';
import { connectionManager } from '../../ocpp/manager';
import { connectorQrUrl } from '../../services/connector.service';
import { validateTariffZones } from '../../services/pricing.service';
import {
  asyncHandler,
  paginate,
  paginationSchema,
  requireAdmin,
  requireAuth,
  requireOperator,
  validate,
} from '../middleware';

export const chargePointsRouter = Router();
chargePointsRouter.use(requireAuth);

const listQuery = paginationSchema.extend({
  search: z.string().optional(),
  online: z.enum(['true', 'false']).optional(),
  status: z.string().optional(),
  clientId: z.string().optional(),
});

chargePointsRouter.get(
  '/',
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const filter: Record<string, unknown> = {};
    if (q.search) {
      filter.$or = [
        { cpId: { $regex: q.search, $options: 'i' } },
        { name: { $regex: q.search, $options: 'i' } },
        { chargePointModel: { $regex: q.search, $options: 'i' } },
        { chargePointVendor: { $regex: q.search, $options: 'i' } },
      ];
    }
    if (q.online) filter.isOnline = q.online === 'true';
    if (req.user?.role === 'CLIENT') {
      const cId = new Types.ObjectId(req.user.clientId);
      filter.$or = [{ clientId: cId }, { linkedClientIds: cId }];
    } else if (q.clientId) {
      if (q.clientId === 'none') {
        filter.clientId = null;
      } else if (isValidObjectId(q.clientId)) {
        filter.clientId = q.clientId;
      }
    }

    const { skip, limit } = paginate(q);
    const [items, total] = await Promise.all([
      ChargePoint.find(filter).sort({ _id: 1 }).skip(skip).limit(limit).lean(),
      ChargePoint.countDocuments(filter),
    ]);

    const ids = items.map((c) => c._id);
    const allClientIds = items.flatMap((c) => [c.clientId, ...(c.linkedClientIds ?? [])]).filter(Boolean);
    const [connectors, clients] = await Promise.all([
      Connector.find({ chargePointId: { $in: ids } }).lean(),
      allClientIds.length > 0
        ? Client.find({ _id: { $in: allClientIds } }).select('_id name businessRegister').lean()
        : [],
    ]);

    const clientMap = new Map<string, { id: string; name: string; businessRegister?: string }>();
    for (const cl of clients) {
      clientMap.set(String(cl._id), {
        id: String(cl._id),
        name: cl.name,
        businessRegister: cl.businessRegister ?? undefined,
      });
    }

    const data = items.map((cp) => ({
      ...cp,
      id: String(cp._id),
      clientId: cp.clientId ? String(cp.clientId) : null,
      client: cp.clientId ? clientMap.get(String(cp.clientId)) ?? null : null,
      linkedClientIds: (cp.linkedClientIds ?? []).map((id) => String(id)),
      linkedClients: (cp.linkedClientIds ?? [])
        .map((id) => clientMap.get(String(id)))
        .filter((c): c is { id: string; name: string; businessRegister?: string } => Boolean(c)),
      // The registry is keyed by the OCPP identifier the station connects with.
      isOnline: connectionManager.isOnline(cp.cpId),
      connectors: connectors
        .filter((c) => String(c.chargePointId) === String(cp._id))
        .sort((a, b) => a.connectorId - b.connectorId)
        .map((c) => ({ ...c, id: String(c._id), qrUrl: c.code ? connectorQrUrl(c.code) : null })),
    }));

    res.json({ data, total, page: q.page, limit: q.limit });
  }),
);

const createSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[\w.:@-]+$/),
  name: z.string().optional(),
  description: z.string().optional(),
  clientId: z.string().nullable().optional(),
  /** Other clients this station should also show up for, beyond the owner. */
  linkedClientIds: z.array(z.string()).optional(),
  /**
   * Omitted generates one. Explicit null means the station authenticates with
   * no HTTP Basic credentials — which is how most hardware ships, and what
   * OCPP_ALLOW_ANONYMOUS exists for.
   */
  authorizationKey: z.string().min(16).max(40).nullable().optional(),
  securityProfile: z.number().int().min(0).max(3).optional(),
  registrationStatus: z.enum(REGISTRATION_STATUSES).optional(),
  heartbeatInterval: z.number().int().min(10).optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  address: z.string().optional(),
  tariffPerKwh: z.number().nonnegative().optional(),
  /** Time-of-day pricing; see the model for how zones are matched. */
  tariffZones: z
    .array(
      z.object({
        name: z.string().trim().max(100).optional(),
        startMinute: z.number().int().min(0).max(1439),
        endMinute: z.number().int().min(1).max(1440),
        tariffPerKwh: z.number().nonnegative(),
      }),
    )
    .optional(),
  /** Overrides the client / network fee. */
  feePercent: z.number().min(0).max(100).optional(),
  /** Overrides the client's e-barimt merchant. */
  ebarimtMerchantId: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

chargePointsRouter.post(
  '/',
  requireOperator,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createSchema>;
    await assertEbarimtMerchant(body.ebarimtMerchantId);
    if (await ChargePoint.exists({ cpId: body.id })) {
      throw conflict(`Charge point ${body.id} already exists`);
    }

    let clientId: string | null = null;
    if (body.clientId) {
      if (!isValidObjectId(body.clientId)) throw badRequest('Invalid clientId');
      const clientExists = await Client.exists({ _id: body.clientId });
      if (!clientExists) throw badRequest('Client not found');
      clientId = body.clientId;
    }
    await assertClientRefs(body.linkedClientIds);
    if (body.tariffZones?.length) {
      const zoneError = validateTariffZones(body.tariffZones);
      if (zoneError) throw badRequest(zoneError);
    }

    // Explicit null: no credentials at all, for a station that sends none.
    // Omitted: generate one satisfying A00.FR.205 (>= 16 bytes, hex, <= 40 chars).
    // It is returned once and only ever stored hashed.
    const anonymous = body.authorizationKey === null;
    const authorizationKey = anonymous
      ? null
      : (body.authorizationKey ?? randomBytes(20).toString('hex'));

    const cp = await ChargePoint.create({
      cpId: body.id,
      name: body.name,
      description: body.description,
      clientId,
      linkedClientIds: body.linkedClientIds ?? [],
      authorizationKeyHash: authorizationKey
        ? await bcrypt.hash(authorizationKey, 12)
        : undefined,
      securityProfile: body.securityProfile ?? 1,
      registrationStatus: body.registrationStatus ?? 'Accepted',
      heartbeatInterval: body.heartbeatInterval ?? 300,
      latitude: body.latitude,
      longitude: body.longitude,
      address: body.address,
      tariffPerKwh: body.tariffPerKwh,
      tariffZones: body.tariffZones ?? [],
      feePercent: body.feePercent,
      ebarimtMerchantId: body.ebarimtMerchantId || undefined,
      tags: body.tags ?? [],
    });

    await Connector.updateOne(
      { chargePointId: cp._id, connectorId: 0 },
      { $setOnInsert: { chargePointId: cp._id, connectorId: 0 } },
      { upsert: true },
    );

    const [client, linkedClients] = await Promise.all([
      clientSummary(cp.clientId),
      clientSummaries(cp.linkedClientIds),
    ]);

    res.status(201).json({
      ...cp.toJSON(),
      clientId: cp.clientId ? String(cp.clientId) : null,
      client,
      linkedClientIds: (cp.linkedClientIds ?? []).map((id) => String(id)),
      linkedClients,
      // Shown once; store it in the charge point's AuthorizationKey config key.
      // Null when the station was registered without credentials.
      authorizationKey,
    });
  }),
);

chargePointsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    // Callers may hold either identifier, so both resolve.
    const cp = (await requireChargePoint(req.params.id!)).toJSON();

    if (req.user?.role === 'CLIENT') {
      const isOwner = String(cp.clientId ?? '') === String(req.user?.clientId);
      const isLinked = (cp.linkedClientIds ?? []).some((id: unknown) => String(id) === String(req.user?.clientId));
      if (!isOwner && !isLinked) {
        throw forbidden('Та зөвхөн өөрийн станцын мэдээллийг харах эрхтэй');
      }
    }

    const [connectors, activeTransactions, configuration, client, linkedClients] = await Promise.all([
      Connector.find({ chargePointId: cp._id }).sort({ connectorId: 1 }).lean(),
      Transaction.find({ chargePointId: cp._id, status: 'Active' }).lean(),
      ConfigurationKey.find({ chargePointId: cp._id }).sort({ key: 1 }).lean(),
      clientSummary(cp.clientId),
      clientSummaries(cp.linkedClientIds),
    ]);

    res.json({
      ...cp,
      id: String(cp._id),
      clientId: cp.clientId ? String(cp.clientId) : null,
      client,
      linkedClientIds: (cp.linkedClientIds ?? []).map((id: unknown) => String(id)),
      linkedClients,
      isOnline: connectionManager.isOnline(cp.cpId),
      // `.lean()` bypasses the toJSON transform that would add `id`, so it is
      // added here: without it the console cannot address a connector to edit.
      connectors: connectors.map((c) => ({
        ...c,
        id: String(c._id),
        qrUrl: c.code ? connectorQrUrl(c.code) : null,
      })),
      activeTransactions,
      configuration,
    });
  }),
);

/**
 * Site metadata is optional, so an edit has to be able to take it back off again
 * — a mistyped coordinate must be removable, not just overwritable. Those fields
 * accept null, which the handler turns into an $unset.
 *
 * `cpId` is editable like anything else now that nothing else stores it: the
 * records all reference `_id`, so changing the identifier a station connects
 * with is a one-field update rather than a migration.
 */
const updateSchema = createSchema.partial().omit({ id: true }).extend({
  cpId: z.string().min(1).max(64).regex(/^[\w.:@-]+$/).optional(),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  clientId: z.string().nullable().optional(),
  linkedClientIds: z.array(z.string()).nullable().optional(),
  address: z.string().nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  tariffPerKwh: z.number().nonnegative().nullable().optional(),
  tariffZones: z
    .array(
      z.object({
        name: z.string().trim().max(100).optional(),
        startMinute: z.number().int().min(0).max(1439),
        endMinute: z.number().int().min(1).max(1440),
        tariffPerKwh: z.number().nonnegative(),
      }),
    )
    .nullable()
    .optional(),
  feePercent: z.number().min(0).max(100).nullable().optional(),
  ebarimtMerchantId: z.string().nullable().optional(),
});

/** An e-barimt merchant reference must point at a real merchant. */
async function assertEbarimtMerchant(id: string | null | undefined): Promise<void> {
  if (!id) return;
  if (!isValidObjectId(id) || !(await EbarimtMerchant.exists({ _id: id }))) {
    throw badRequest('E-barimt merchant not found');
  }
}

type ClientSummary = { id: string; name: string; businessRegister?: string };

/** Every id in the list must point at a real client. */
async function assertClientRefs(ids: string[] | null | undefined): Promise<void> {
  if (!ids || ids.length === 0) return;
  for (const id of ids) {
    if (!isValidObjectId(id)) throw badRequest('Invalid linkedClientIds entry');
  }
  const count = await Client.countDocuments({ _id: { $in: ids } });
  if (count !== new Set(ids).size) throw badRequest('One or more linked clients not found');
}

async function clientSummary(id: unknown): Promise<ClientSummary | null> {
  if (!id) return null;
  const cl = await Client.findById(id).select('_id name businessRegister').lean();
  if (!cl) return null;
  return { id: String(cl._id), name: cl.name, businessRegister: cl.businessRegister ?? undefined };
}

async function clientSummaries(ids: unknown[] | null | undefined): Promise<ClientSummary[]> {
  if (!ids || ids.length === 0) return [];
  const found = await Client.find({ _id: { $in: ids } }).select('_id name businessRegister').lean();
  return found.map((cl) => ({
    id: String(cl._id),
    name: cl.name,
    businessRegister: cl.businessRegister ?? undefined,
  }));
}

chargePointsRouter.patch(
  '/:id',
  requireOperator,
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updateSchema>;
    const cp = await requireChargePoint(req.params.id!);
    await assertEbarimtMerchant(body.ebarimtMerchantId);

    if (body.cpId !== undefined && body.cpId !== cp.cpId) {
      if (await ChargePoint.exists({ cpId: body.cpId })) {
        throw conflict(`Charge point ${body.cpId} already exists`);
      }
      // The station authenticates as its identifier, so the live socket belongs
      // to the old one and has to go; it reconnects once reconfigured.
      connectionManager.get(cp.cpId)?.close(1000, 'Charge point identifier changed');
    }

    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ''> = {};

    if (body.clientId !== undefined) {
      if (body.clientId === null || body.clientId === '') {
        $unset.clientId = '';
      } else {
        if (!isValidObjectId(body.clientId)) throw badRequest('Invalid clientId');
        const clientExists = await Client.exists({ _id: body.clientId });
        if (!clientExists) throw badRequest('Client not found');
        $set.clientId = body.clientId;
      }
    }

    if (body.linkedClientIds !== undefined) {
      if (body.linkedClientIds === null || body.linkedClientIds.length === 0) {
        $set.linkedClientIds = [];
      } else {
        await assertClientRefs(body.linkedClientIds);
        $set.linkedClientIds = body.linkedClientIds;
      }
    }

    if (body.tariffZones !== undefined) {
      if (body.tariffZones === null || body.tariffZones.length === 0) {
        $set.tariffZones = [];
      } else {
        const zoneError = validateTariffZones(body.tariffZones);
        if (zoneError) throw badRequest(zoneError);
        $set.tariffZones = body.tariffZones;
      }
    }

    for (const [key, value] of Object.entries(body)) {
      if (key === 'authorizationKey' || key === 'clientId' || key === 'linkedClientIds' || key === 'tariffZones') {
        continue;
      }
      if (value === null) $unset[key] = '';
      else $set[key] = value;
    }

    let newKey: string | undefined;
    if (body.authorizationKey !== undefined) {
      if (body.authorizationKey === null) {
        // Drop the credentials: the station connects with no HTTP Basic, which
        // is how most hardware ships. Lets a charge point created with a key be
        // made anonymous without deleting and re-registering it.
        $unset.authorizationKeyHash = '';
      } else {
        newKey = body.authorizationKey;
        $set.authorizationKeyHash = await bcrypt.hash(newKey, 12);
      }
    }

    const update: Record<string, unknown> = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;

    const updated = await ChargePoint.findByIdAndUpdate(cp._id, update, { new: true });
    if (!updated) throw notFound('Charge point not found');

    const [client, linkedClients] = await Promise.all([
      clientSummary(updated.clientId),
      clientSummaries(updated.linkedClientIds),
    ]);

    res.json({
      ...updated.toJSON(),
      clientId: updated.clientId ? String(updated.clientId) : null,
      client,
      linkedClientIds: (updated.linkedClientIds ?? []).map((id) => String(id)),
      linkedClients,
      ...(newKey ? { authorizationKey: newKey } : {}),
    });
  }),
);

/** Rotate the HTTP Basic password (white paper use case A01). */
chargePointsRouter.post(
  '/:id/rotate-authorization-key',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const cp = await requireChargePoint(req.params.id!);

    const authorizationKey = randomBytes(20).toString('hex');
    cp.authorizationKeyHash = await bcrypt.hash(authorizationKey, 12);
    await cp.save();

    // A01: push the new key to the charge point if it is online. It will
    // reconnect using the new credentials.
    let pushed: unknown = null;
    if (connectionManager.isOnline(cp.cpId)) {
      pushed = await connectionManager
        .send(cp.cpId, 'ChangeConfiguration', {
          key: 'AuthorizationKey',
          value: authorizationKey,
        }, req.user?.email)
        .catch((err: Error) => ({ error: err.message }));
    }

    res.json({ authorizationKey, pushed });
  }),
);

chargePointsRouter.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const cp = await requireChargePoint(req.params.id!);
    await ChargePoint.findByIdAndDelete(cp._id);
    connectionManager.get(cp.cpId)?.close(1000, 'Charge point removed');
    await Promise.all([
      Connector.deleteMany({ chargePointId: cp._id }),
      ConfigurationKey.deleteMany({ chargePointId: cp._id }),
    ]);
    res.status(204).end();
  }),
);

/**
 * This router is mounted before `connectorAdminRouter`, so this handler shadows
 * the equivalent one there. Kept in step with it — both return `id` and the
 * sticker URL — so which one answers is not something a caller has to care about.
 */
chargePointsRouter.get(
  '/:id/connectors',
  asyncHandler(async (req, res) => {
    const cp = await requireChargePoint(req.params.id!);
    const rows = await Connector.find({ chargePointId: cp._id }).sort({ connectorId: 1 }).lean();
    res.json(
      rows.map((c) => ({
        ...c,
        id: String(c._id),
        qrUrl: c.code ? connectorQrUrl(c.code) : null,
      })),
    );
  }),
);

const logQuery = paginationSchema.extend({
  action: z.string().optional(),
  direction: z.enum(['IN', 'OUT']).optional(),
});

chargePointsRouter.get(
  '/:id/messages',
  validate(logQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof logQuery>;
    const cp = await requireChargePoint(req.params.id!);
    const filter: Record<string, unknown> = { chargePointId: cp._id };
    if (q.action) filter.action = q.action;
    if (q.direction) filter.direction = q.direction;

    const { skip, limit } = paginate(q);
    const [data, total] = await Promise.all([
      OcppMessageLog.find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
      OcppMessageLog.countDocuments(filter),
    ]);
    res.json({ data, total, page: q.page, limit: q.limit });
  }),
);

chargePointsRouter.get(
  '/:id/commands',
  validate(paginationSchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof paginationSchema>;
    const { skip, limit } = paginate(q);
    const cp = await requireChargePoint(req.params.id!);
    const filter = { chargePointId: cp._id };
    const [data, total] = await Promise.all([
      CommandLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      CommandLog.countDocuments(filter),
    ]);
    res.json({ data, total, page: q.page, limit: q.limit });
  }),
);

/** Force-close the WebSocket, e.g. to make a charge point re-authenticate. */
chargePointsRouter.post(
  '/:id/disconnect',
  requireOperator,
  asyncHandler(async (req, res) => {
    const cp = await requireChargePoint(req.params.id!);
    const conn = connectionManager.get(cp.cpId);
    if (!conn) throw notFound('Charge point is not connected');
    conn.close(1000, 'Disconnected by operator');
    res.json({ ok: true });
  }),
);

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { badRequest, notFound, conflict } from '../../lib/errors';
import { requireChargePoint } from '../../lib/chargePointRef';
import { ChargePoint } from '../../models/ChargePoint';
import { Connector } from '../../models/Connector';
import { Transaction } from '../../models/Transaction';
import { ConfigurationKey } from '../../models/ConfigurationKey';
import { OcppMessageLog, CommandLog } from '../../models/Log';
import { REGISTRATION_STATUSES } from '../../models/enums';
import { connectionManager } from '../../ocpp/manager';
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

    const { skip, limit } = paginate(q);
    const [items, total] = await Promise.all([
      ChargePoint.find(filter).sort({ _id: 1 }).skip(skip).limit(limit).lean(),
      ChargePoint.countDocuments(filter),
    ]);

    const ids = items.map((c) => c._id);
    const connectors = await Connector.find({ chargePointId: { $in: ids } }).lean();

    const data = items.map((cp) => ({
      ...cp,
      id: String(cp._id),
      // The registry is keyed by the OCPP identifier the station connects with.
      isOnline: connectionManager.isOnline(cp.cpId),
      connectors: connectors
        .filter((c) => String(c.chargePointId) === String(cp._id))
        .sort((a, b) => a.connectorId - b.connectorId),
    }));

    res.json({ data, total, page: q.page, limit: q.limit });
  }),
);

const createSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[\w.:@-]+$/),
  name: z.string().optional(),
  description: z.string().optional(),
  authorizationKey: z.string().min(16).max(40).optional(),
  securityProfile: z.number().int().min(0).max(3).optional(),
  registrationStatus: z.enum(REGISTRATION_STATUSES).optional(),
  heartbeatInterval: z.number().int().min(10).optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  address: z.string().optional(),
  tariffPerKwh: z.number().nonnegative().optional(),
  tags: z.array(z.string()).optional(),
});

chargePointsRouter.post(
  '/',
  requireOperator,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createSchema>;
    if (await ChargePoint.exists({ cpId: body.id })) {
      throw conflict(`Charge point ${body.id} already exists`);
    }

    // If no key is supplied, generate one that satisfies A00.FR.205 (>= 16 bytes,
    // hex, max 40 characters). It is returned once and only stored hashed.
    const authorizationKey = body.authorizationKey ?? randomBytes(20).toString('hex');

    const cp = await ChargePoint.create({
      cpId: body.id,
      name: body.name,
      description: body.description,
      authorizationKeyHash: await bcrypt.hash(authorizationKey, 12),
      securityProfile: body.securityProfile ?? 1,
      registrationStatus: body.registrationStatus ?? 'Accepted',
      heartbeatInterval: body.heartbeatInterval ?? 300,
      latitude: body.latitude,
      longitude: body.longitude,
      address: body.address,
      tariffPerKwh: body.tariffPerKwh,
      tags: body.tags ?? [],
    });

    await Connector.updateOne(
      { chargePointId: cp._id, connectorId: 0 },
      { $setOnInsert: { chargePointId: cp._id, connectorId: 0 } },
      { upsert: true },
    );

    res.status(201).json({
      ...cp.toJSON(),
      // Shown once; store it in the charge point's AuthorizationKey config key.
      authorizationKey,
    });
  }),
);

chargePointsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    // Callers may hold either identifier, so both resolve.
    const cp = (await requireChargePoint(req.params.id!)).toJSON();

    const [connectors, activeTransactions, configuration] = await Promise.all([
      Connector.find({ chargePointId: cp._id }).sort({ connectorId: 1 }).lean(),
      Transaction.find({ chargePointId: cp._id, status: 'Active' }).lean(),
      ConfigurationKey.find({ chargePointId: cp._id }).sort({ key: 1 }).lean(),
    ]);

    res.json({
      ...cp,
      id: String(cp._id),
      isOnline: connectionManager.isOnline(cp.cpId),
      connectors,
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
  address: z.string().nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  tariffPerKwh: z.number().nonnegative().nullable().optional(),
});

chargePointsRouter.patch(
  '/:id',
  requireOperator,
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updateSchema>;
    const cp = await requireChargePoint(req.params.id!);

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
    for (const [key, value] of Object.entries(body)) {
      if (key === 'authorizationKey') continue;
      if (value === null) $unset[key] = '';
      else $set[key] = value;
    }

    let newKey: string | undefined;
    if (body.authorizationKey !== undefined) {
      newKey = body.authorizationKey;
      $set.authorizationKeyHash = await bcrypt.hash(newKey, 12);
    }

    const update: Record<string, unknown> = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;

    const updated = await ChargePoint.findByIdAndUpdate(cp._id, update, { new: true });
    if (!updated) throw notFound('Charge point not found');
    res.json({ ...updated.toJSON(), ...(newKey ? { authorizationKey: newKey } : {}) });
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

chargePointsRouter.get(
  '/:id/connectors',
  asyncHandler(async (req, res) => {
    const cp = await requireChargePoint(req.params.id!);
    res.json(await Connector.find({ chargePointId: cp._id }).sort({ connectorId: 1 }));
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

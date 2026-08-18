import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { notFound, conflict } from '../../lib/errors';
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
        { _id: { $regex: q.search, $options: 'i' } },
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
      id: cp._id,
      isOnline: connectionManager.isOnline(cp._id),
      connectors: connectors
        .filter((c) => c.chargePointId === cp._id)
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
    if (await ChargePoint.exists({ _id: body.id })) {
      throw conflict(`Charge point ${body.id} already exists`);
    }

    // If no key is supplied, generate one that satisfies A00.FR.205 (>= 16 bytes,
    // hex, max 40 characters). It is returned once and only stored hashed.
    const authorizationKey = body.authorizationKey ?? randomBytes(20).toString('hex');

    const cp = await ChargePoint.create({
      _id: body.id,
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
      { chargePointId: body.id, connectorId: 0 },
      { $setOnInsert: { chargePointId: body.id, connectorId: 0 } },
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
    const cp = await ChargePoint.findById(req.params.id).lean();
    if (!cp) throw notFound('Charge point not found');

    const [connectors, activeTransactions, configuration] = await Promise.all([
      Connector.find({ chargePointId: cp._id }).sort({ connectorId: 1 }).lean(),
      Transaction.find({ chargePointId: cp._id, status: 'Active' }).lean(),
      ConfigurationKey.find({ chargePointId: cp._id }).sort({ key: 1 }).lean(),
    ]);

    res.json({
      ...cp,
      id: cp._id,
      isOnline: connectionManager.isOnline(cp._id),
      connectors,
      activeTransactions,
      configuration,
    });
  }),
);

const updateSchema = createSchema.partial().omit({ id: true });

chargePointsRouter.patch(
  '/:id',
  requireOperator,
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updateSchema>;
    const update: Record<string, unknown> = { ...body };
    delete update.authorizationKey;

    let newKey: string | undefined;
    if (body.authorizationKey !== undefined) {
      newKey = body.authorizationKey;
      update.authorizationKeyHash = await bcrypt.hash(newKey, 12);
    }

    const cp = await ChargePoint.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!cp) throw notFound('Charge point not found');
    res.json({ ...cp.toJSON(), ...(newKey ? { authorizationKey: newKey } : {}) });
  }),
);

/** Rotate the HTTP Basic password (white paper use case A01). */
chargePointsRouter.post(
  '/:id/rotate-authorization-key',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const cp = await ChargePoint.findById(req.params.id);
    if (!cp) throw notFound('Charge point not found');

    const authorizationKey = randomBytes(20).toString('hex');
    cp.authorizationKeyHash = await bcrypt.hash(authorizationKey, 12);
    await cp.save();

    // A01: push the new key to the charge point if it is online. It will
    // reconnect using the new credentials.
    let pushed: unknown = null;
    if (connectionManager.isOnline(cp._id)) {
      pushed = await connectionManager
        .send(cp._id, 'ChangeConfiguration', {
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
    const cp = await ChargePoint.findByIdAndDelete(req.params.id);
    if (!cp) throw notFound('Charge point not found');
    connectionManager.get(req.params.id)?.close(1000, 'Charge point removed');
    await Promise.all([
      Connector.deleteMany({ chargePointId: req.params.id }),
      ConfigurationKey.deleteMany({ chargePointId: req.params.id }),
    ]);
    res.status(204).end();
  }),
);

chargePointsRouter.get(
  '/:id/connectors',
  asyncHandler(async (req, res) => {
    res.json(await Connector.find({ chargePointId: req.params.id }).sort({ connectorId: 1 }));
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
    const filter: Record<string, unknown> = { chargePointId: req.params.id };
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
    const filter = { chargePointId: req.params.id };
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
    const conn = connectionManager.get(req.params.id);
    if (!conn) throw notFound('Charge point is not connected');
    conn.close(1000, 'Disconnected by operator');
    res.json({ ok: true });
  }),
);

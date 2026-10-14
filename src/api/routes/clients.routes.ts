import { Router } from 'express';
import { z } from 'zod';
import { isValidObjectId, Types } from 'mongoose';
import { badRequest, notFound } from '../../lib/errors';
import { EbarimtMerchant } from '../../models/EbarimtMerchant';
import { Client } from '../../models/Client';
import { ChargePoint } from '../../models/ChargePoint';
import { Connector } from '../../models/Connector';
import { connectionManager } from '../../ocpp/manager';
import {
  asyncHandler,
  paginate,
  paginationSchema,
  requireAuth,
  requireOperator,
  validate,
} from '../middleware';

export const clientsRouter = Router();
clientsRouter.use(requireAuth);

const listQuery = paginationSchema.extend({
  search: z.string().optional(),
  status: z.enum(['all', 'active', 'inactive']).optional(),
});

const clientInputSchema = z.object({
  name: z.string().min(1, 'Харилцагчийн нэрийг оруулна уу').max(200),
  businessRegister: z.string().max(50).optional().nullable(),
  contactPerson: z.string().max(100).optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  email: z.string().email('Имэйл хаяг буруу байна').optional().nullable().or(z.literal('')),
  address: z.string().max(300).optional().nullable(),
  description: z.string().max(1000).optional().nullable(),
  isActive: z.boolean().default(true),
  /** Eplug's service fee on this client's stations. Null = network default. */
  feePercent: z.number().min(0).max(100).optional().nullable(),
  /** Receipts for this client's stations are issued under this merchant. */
  ebarimtMerchantId: z.string().optional().nullable(),
  payoutAccount: z
    .object({
      bankCode: z.string().max(20).optional(),
      bankName: z.string().max(100).optional(),
      accountNumber: z.string().max(50).optional(),
      accountName: z.string().max(200).optional(),
    })
    .optional()
    .nullable(),
});

async function assertEbarimtMerchant(id: string | null | undefined): Promise<void> {
  if (!id) return;
  if (!isValidObjectId(id) || !(await EbarimtMerchant.exists({ _id: id }))) {
    throw badRequest('E-barimt merchant not found');
  }
}

clientsRouter.get(
  '/',
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const filter: Record<string, unknown> = {};

    if (q.search) {
      filter.$or = [
        { name: { $regex: q.search, $options: 'i' } },
        { businessRegister: { $regex: q.search, $options: 'i' } },
        { contactPerson: { $regex: q.search, $options: 'i' } },
        { phone: { $regex: q.search, $options: 'i' } },
      ];
    }

    if (q.status === 'active') filter.isActive = true;
    else if (q.status === 'inactive') filter.isActive = false;

    const { skip, limit } = paginate(q);
    const [clients, total] = await Promise.all([
      Client.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Client.countDocuments(filter),
    ]);

    // Count stations per client in this batch — a station counts for its
    // owner (clientId) and for every client it is additionally linked to.
    const clientIds = clients.map((c) => c._id);
    const stationCounts = await ChargePoint.aggregate<{ _id: Types.ObjectId; count: number }>([
      {
        $project: {
          allClientIds: {
            $setUnion: [
              { $cond: [{ $ifNull: ['$clientId', false] }, ['$clientId'], []] },
              { $ifNull: ['$linkedClientIds', []] },
            ],
          },
        },
      },
      { $unwind: '$allClientIds' },
      { $match: { allClientIds: { $in: clientIds } } },
      { $group: { _id: '$allClientIds', count: { $sum: 1 } } },
    ]);

    const countMap = new Map<string, number>();
    for (const sc of stationCounts) {
      countMap.set(String(sc._id), sc.count);
    }

    const data = clients.map((c) => ({
      ...c,
      id: String(c._id),
      stationCount: countMap.get(String(c._id)) ?? 0,
    }));

    res.json({ data, total, page: q.page, limit: q.limit });
  }),
);

clientsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isValidObjectId(id)) throw badRequest('Invalid client id');

    const client = await Client.findById(id).lean();
    if (!client) throw notFound('Client not found');

    // Owned stations and stations merely linked (visible/usable but billed to
    // their own owner) both belong on this client's page — `owned` says which.
    const stations = await ChargePoint.find({
      $or: [{ clientId: client._id }, { linkedClientIds: client._id }],
    })
      .sort({ cpId: 1 })
      .lean();
    const stationIds = stations.map((s) => s._id);
    const connectors = await Connector.find({ chargePointId: { $in: stationIds } }).lean();

    const populatedStations = stations.map((cp) => ({
      ...cp,
      id: String(cp._id),
      owned: String(cp.clientId ?? '') === String(client._id),
      isOnline: connectionManager.isOnline(cp.cpId),
      connectors: connectors
        .filter((c) => String(c.chargePointId) === String(cp._id))
        .sort((a, b) => a.connectorId - b.connectorId),
    }));

    res.json({
      ...client,
      id: String(client._id),
      stationCount: populatedStations.length,
      stations: populatedStations,
    });
  }),
);

clientsRouter.post(
  '/',
  requireOperator,
  validate(clientInputSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof clientInputSchema>;
    await assertEbarimtMerchant(body.ebarimtMerchantId);

    const created = await Client.create({
      name: body.name.trim(),
      businessRegister: body.businessRegister?.trim() || null,
      contactPerson: body.contactPerson?.trim() || null,
      phone: body.phone?.trim() || null,
      email: body.email?.trim() || null,
      address: body.address?.trim() || null,
      description: body.description?.trim() || null,
      isActive: body.isActive ?? true,
      feePercent: body.feePercent ?? undefined,
      ebarimtMerchantId: body.ebarimtMerchantId || undefined,
      payoutAccount: body.payoutAccount ?? undefined,
    });

    res.status(201).json({
      ...created.toJSON(),
      id: String(created._id),
      stationCount: 0,
    });
  }),
);

clientsRouter.patch(
  '/:id',
  requireOperator,
  validate(clientInputSchema.partial()),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isValidObjectId(id)) throw badRequest('Invalid client id');

    const body = req.body as Partial<z.infer<typeof clientInputSchema>>;
    await assertEbarimtMerchant(body.ebarimtMerchantId);
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ''> = {};

    for (const [key, value] of Object.entries(body)) {
      if (value === null || value === '') {
        $unset[key] = '';
      } else if (value !== undefined) {
        $set[key] = typeof value === 'string' ? value.trim() : value;
      }
    }

    const update: Record<string, unknown> = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;

    const updated = await Client.findByIdAndUpdate(id, update, { new: true }).lean();
    if (!updated) throw notFound('Client not found');

    const stationCount = await ChargePoint.countDocuments({ clientId: updated._id });

    res.json({
      ...updated,
      id: String(updated._id),
      stationCount,
    });
  }),
);

clientsRouter.delete(
  '/:id',
  requireOperator,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isValidObjectId(id)) throw badRequest('Invalid client id');

    const client = await Client.findByIdAndDelete(id);
    if (!client) throw notFound('Client not found');

    // Unlink any charge points associated with this client, owned or merely linked
    await Promise.all([
      ChargePoint.updateMany({ clientId: client._id }, { $set: { clientId: null } }),
      ChargePoint.updateMany(
        { linkedClientIds: client._id },
        { $pull: { linkedClientIds: client._id } },
      ),
    ]);

    res.status(204).end();
  }),
);

clientsRouter.get(
  '/:id/stations',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isValidObjectId(id)) throw badRequest('Invalid client id');

    const stations = await ChargePoint.find({
      $or: [{ clientId: id }, { linkedClientIds: id }],
    })
      .sort({ cpId: 1 })
      .lean();
    const stationIds = stations.map((s) => s._id);
    const connectors = await Connector.find({ chargePointId: { $in: stationIds } }).lean();

    const data = stations.map((cp) => ({
      ...cp,
      id: String(cp._id),
      owned: String(cp.clientId ?? '') === String(id),
      isOnline: connectionManager.isOnline(cp.cpId),
      connectors: connectors
        .filter((c) => String(c.chargePointId) === String(cp._id))
        .sort((a, b) => a.connectorId - b.connectorId),
    }));

    res.json({ data, total: data.length });
  }),
);

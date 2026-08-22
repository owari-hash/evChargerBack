import { Router } from 'express';
import { chargePointRefs, optionalChargePointRef } from '../../lib/chargePointRef';
import { z } from 'zod';
import { conflict, notFound } from '../../lib/errors';
import { IdTag, LocalAuthListEntry } from '../../models/IdTag';
import { Transaction } from '../../models/Transaction';
import { AUTHORIZATION_STATUSES } from '../../models/enums';
import { authorizeIdTag } from '../../services/authorization.service';
import {
  asyncHandler,
  paginate,
  paginationSchema,
  requireAuth,
  requireOperator,
  validate,
} from '../middleware';

export const idTagsRouter = Router();
idTagsRouter.use(requireAuth);

const listQuery = paginationSchema.extend({
  search: z.string().optional(),
  status: z.enum(AUTHORIZATION_STATUSES).optional(),
});

idTagsRouter.get(
  '/',
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.search) {
      filter.$or = [
        { _id: { $regex: q.search, $options: 'i' } },
        { label: { $regex: q.search, $options: 'i' } },
        { ownerName: { $regex: q.search, $options: 'i' } },
        { ownerEmail: { $regex: q.search, $options: 'i' } },
      ];
    }
    const { skip, limit } = paginate(q);
    const [data, total] = await Promise.all([
      IdTag.find(filter).sort({ _id: 1 }).skip(skip).limit(limit).lean(),
      IdTag.countDocuments(filter),
    ]);
    res.json({
      data: data.map((t) => ({ ...t, idTag: t._id })),
      total,
      page: q.page,
      limit: q.limit,
    });
  }),
);

const createSchema = z.object({
  idTag: z.string().min(1).max(20),
  parentIdTag: z.string().max(20).optional(),
  status: z.enum(AUTHORIZATION_STATUSES).default('Accepted'),
  expiryDate: z.coerce.date().optional(),
  label: z.string().optional(),
  ownerName: z.string().optional(),
  ownerEmail: z.string().email().optional(),
  maxActiveTransactions: z.number().int().min(0).default(1),
  allowedChargePointIds: z.array(z.string()).optional(),
  note: z.string().optional(),
});

idTagsRouter.post(
  '/',
  requireOperator,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createSchema>;
    if (await IdTag.exists({ _id: body.idTag })) {
      throw conflict(`idTag "${body.idTag}" already exists`);
    }
    const { idTag, allowedChargePointIds, ...rest } = body;
    const doc = await IdTag.create({
      _id: idTag,
      ...rest,
      ...(allowedChargePointIds
        ? { allowedChargePointIds: await chargePointRefs(allowedChargePointIds) }
        : {}),
    });
    res.status(201).json(doc.toJSON());
  }),
);

idTagsRouter.get(
  '/:idTag',
  asyncHandler(async (req, res) => {
    const tag = await IdTag.findById(req.params.idTag).lean();
    if (!tag) throw notFound('idTag not found');
    const activeTransactions = await Transaction.countDocuments({
      idTag: req.params.idTag,
      status: 'Active',
    });
    res.json({ ...tag, idTag: tag._id, activeTransactions });
  }),
);

const updateSchema = createSchema.partial().omit({ idTag: true });

idTagsRouter.patch(
  '/:idTag',
  requireOperator,
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updateSchema>;
    const tag = await IdTag.findByIdAndUpdate(
      req.params.idTag,
      {
        ...body,
        ...(body.allowedChargePointIds
          ? { allowedChargePointIds: await chargePointRefs(body.allowedChargePointIds) }
          : {}),
      },
      { new: true },
    );
    if (!tag) throw notFound('idTag not found');
    res.json(tag.toJSON());
  }),
);

idTagsRouter.delete(
  '/:idTag',
  requireOperator,
  asyncHandler(async (req, res) => {
    const tag = await IdTag.findByIdAndDelete(req.params.idTag);
    if (!tag) throw notFound('idTag not found');
    await LocalAuthListEntry.deleteMany({ idTag: req.params.idTag });
    res.status(204).end();
  }),
);

/** Dry-run the authorization logic without a charge point being involved. */
idTagsRouter.post(
  '/:idTag/authorize-check',
  asyncHandler(async (req, res) => {
    const named = typeof req.body?.chargePointId === 'string' ? req.body.chargePointId : undefined;
    res.json(
      await authorizeIdTag(req.params.idTag, {
        chargePointId: await optionalChargePointRef(named),
      }),
    );
  }),
);

/** Bulk import, useful for migrating an existing tag database. */
const bulkSchema = z.object({ tags: z.array(createSchema).min(1).max(5000) });

idTagsRouter.post(
  '/bulk',
  requireOperator,
  validate(bulkSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof bulkSchema>;
    // The allow-list is written by station name but stored by reference, so
    // renaming a station cannot silently widen or void a tag's restriction.
    const prepared = await Promise.all(
      body.tags.map(async ({ idTag, allowedChargePointIds, ...rest }) => ({
        idTag,
        rest: {
          ...rest,
          ...(allowedChargePointIds
            ? { allowedChargePointIds: await chargePointRefs(allowedChargePointIds) }
            : {}),
        },
      })),
    );
    const result = await IdTag.bulkWrite(
      prepared.map(({ idTag, rest }) => ({
        updateOne: {
          filter: { _id: idTag },
          update: { $set: rest, $setOnInsert: { _id: idTag } },
          upsert: true,
        },
      })),
    );
    res.json({ inserted: result.upsertedCount, updated: result.modifiedCount });
  }),
);

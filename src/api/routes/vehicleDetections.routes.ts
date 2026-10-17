import { Router } from 'express';
import { z } from 'zod';
import { VehicleDetection } from '../../models/VehicleDetection';
import { notFound } from '../../lib/errors';
import {
  asyncHandler,
  paginate,
  paginationSchema,
  requireAuth,
  validate,
} from '../middleware';

export const vehicleDetectionsRouter = Router();

vehicleDetectionsRouter.use(requireAuth);

const querySchema = paginationSchema.extend({
  cpId: z.string().optional(),
  vin: z.string().optional(),
  source: z.string().optional(),
});

/** List all detected vehicles & VIN captures, newest first */
vehicleDetectionsRouter.get(
  '/',
  validate(querySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof querySchema>;
    const filter: Record<string, unknown> = {};

    if (q.cpId) filter.cpId = new RegExp(q.cpId.trim(), 'i');
    if (q.vin) filter.vin = new RegExp(q.vin.trim(), 'i');
    if (q.source) filter.source = q.source;

    const { skip, limit } = paginate(q);
    const [data, total] = await Promise.all([
      VehicleDetection.find(filter).sort({ detectedAt: -1 }).skip(skip).limit(limit).lean(),
      VehicleDetection.countDocuments(filter),
    ]);

    res.json({
      data: data.map((d) => ({ ...d, id: d._id })),
      total,
      page: q.page,
      limit: q.limit,
    });
  }),
);

/** Get a single vehicle detection record with full raw payload */
vehicleDetectionsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const doc = await VehicleDetection.findById(req.params.id).lean();
    if (!doc) throw notFound('Vehicle detection record not found');
    res.json({ ...doc, id: doc._id });
  }),
);

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, requireAuth, validate } from '../middleware';
import { getAnalyticsOverview, recordAccess } from '../../services/analytics.service';

export const analyticsRouter = Router();

const overviewQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
});

/**
 * GET /api/analytics/overview?days=7
 * Returns Google-Analytics-style website & mobile app traffic statistics.
 */
analyticsRouter.get(
  '/overview',
  requireAuth,
  validate(overviewQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof overviewQuery>;
    const overview = await getAnalyticsOverview(q.days);
    res.json(overview);
  }),
);

/**
 * POST /api/analytics/collect (Internal or web beacon endpoint)
 */
analyticsRouter.post(
  '/collect',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    await recordAccess(
      {
        path: body.path,
        referrer: body.referrer,
        platform: body.platform,
        userAgent: body.userAgent,
      },
      req,
    );
    res.status(204).end();
  }),
);

import { Router } from 'express';
import { z } from 'zod';
import { Feedback } from '../../models/Feedback';
import { getCurrentUser } from '../auth/session';
import { badRequest, guard, HOUR, parseBody, route } from '../http';

/** POST /app-api/feedback — «Санал хүсэлт» from the kiosk footer or the app. */
export const feedbackRoutes = Router();

const feedbackSchema = z.object({
  message: z.string().trim().min(3, 'Санал хүсэлтээ бичнэ үү').max(2000),
  /** Only read for guests; a signed-in driver's own phone is used instead. */
  phone: z.string().trim().max(32).optional(),
  source: z.enum(['web', 'app']).default('web'),
});

feedbackRoutes.post(
  '/',
  route(async (req) => {
    guard(req, 'feedback', 20, HOUR);
    const body = parseBody(req, feedbackSchema);
    const user = await getCurrentUser(req);

    const phone = user?.phone ?? body.phone?.replace(/[^\d+]/g, '');
    if (!user && (!phone || phone.replace(/\D/g, '').length < 8)) {
      throw badRequest('Утасны дугаараа оруулна уу');
    }

    const saved = await Feedback.create({
      message: body.message,
      phone,
      userId: user?.id,
      userName: user?.name,
      source: body.source,
    });
    return { ok: true, id: String(saved._id) };
  }),
);

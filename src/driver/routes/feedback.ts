import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { Feedback } from '../../models/Feedback';
import { getCurrentUser } from '../auth/session';
import { badRequest, driverLogger, guard, HOUR, route } from '../http';
import { sendSms } from '../notify';

export const feedbackRoutes = Router();

const DEFAULT_NOTIFY_PHONES = ['88887207', '95393408', '99246123'];

const feedbackSchema = z.object({
  message: z.string().trim().min(3, 'Санал хүсэлтээ бичнэ үү').max(2000),
  phone: z.string().trim().optional(),
  source: z.string().trim().optional().default('web'),
});

feedbackRoutes.post(
  '/',
  route(async (req) => {
    // 30 per hour per IP to protect against spam / SMS flooding
    guard(req, 'feedback', 30, HOUR);

    const user = await getCurrentUser(req);
    const parsed = feedbackSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0]?.message || 'Санал хүсэлтээ бичнэ үү';
      throw badRequest(issue);
    }

    const { message, phone: rawPhone, source } = parsed.data;
    const resolvedPhone = rawPhone?.trim() || user?.phone?.trim() || undefined;

    // Save feedback document
    const feedbackDoc = await Feedback.create({
      phone: resolvedPhone,
      message,
      source: source || 'web',
      userId: user?.id,
      userName: user?.name,
      status: 'new',
    });

    // Format SMS: "sanal huselt irlee." (no message content)
    const cleanPhone = resolvedPhone ? resolvedPhone.replace(/\D/g, '').slice(-8) : '';
    const smsText = cleanPhone ? `sanal huselt irlee.` : `sanal huselt irlee.`;

    // Target phones: defaults to 88887207, 95393408, 99246123
    const configured = (env.FEEDBACK_NOTIFY_PHONES || DEFAULT_NOTIFY_PHONES.join(','))
      .split(',')
      .map((p) => p.trim())
      .filter((p) => /^\d{8}$/.test(p.replace(/\D/g, '')));

    const targetPhones = configured.length > 0 ? configured : DEFAULT_NOTIFY_PHONES;

    const delivered: string[] = [];
    await Promise.allSettled(
      targetPhones.map(async (recipient) => {
        try {
          const res = await sendSms({
            to: recipient,
            text: smsText,
          });
          if (res.delivered) {
            delivered.push(recipient);
          } else {
            driverLogger.warn(
              { recipient, error: res.error },
              'Failed to deliver feedback SMS notification',
            );
          }
        } catch (err) {
          driverLogger.warn(
            { recipient, err: (err as Error).message },
            'Exception sending feedback SMS',
          );
        }
      }),
    );

    if (delivered.length > 0) {
      await Feedback.updateOne(
        { _id: feedbackDoc._id },
        { $set: { smsDeliveredTo: delivered } },
      ).catch(() => undefined);
    }

    driverLogger.info(
      {
        feedbackId: String(feedbackDoc._id),
        delivered,
        total: targetPhones.length,
        fromPhone: resolvedPhone,
        smsText,
      },
      'Feedback received and SMS dispatched to operators',
    );

    return { ok: true, id: String(feedbackDoc._id) };
  }),
);

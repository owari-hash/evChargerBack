import { Router } from 'express';
import { z } from 'zod';
import { ContactInfo, getOrCreateContactInfo } from '../../models/ContactInfo';
import { asyncHandler, requireAuth, requireOperator, validate } from '../middleware';

export const contactRouter = Router();

const contactSchema = z.object({
  phone: z.string().trim().min(1, 'Утасны дугаар оруулна уу').max(100),
  email: z.string().trim().email('И-мэйл хаяг буруу байна').max(100),
  address: z.string().trim().max(255).optional().default(''),
  facebookUrl: z.string().trim().max(255).optional().default(''),
  facebookName: z.string().trim().max(100).optional().default(''),
  instagramUrl: z.string().trim().max(255).optional().default(''),
  instagramName: z.string().trim().max(100).optional().default(''),
  logoDownloadUrl: z.string().trim().max(255).optional().default('/eplug-mark.png'),
});

/**
 * GET /api/contact
 * Return the current contact & social information.
 */
contactRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const info = await getOrCreateContactInfo();
    res.json(info.toJSON());
  }),
);

/**
 * PUT /api/contact
 * Update contact & social configuration. Requires OPERATOR or ADMIN role.
 */
contactRouter.put(
  '/',
  requireAuth,
  requireOperator,
  validate(contactSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof contactSchema>;
    let doc = await ContactInfo.findOne();
    if (!doc) {
      doc = new ContactInfo({
        ...body,
        updatedBy: req.user?.email ?? 'operator',
      });
    } else {
      doc.set({
        ...body,
        updatedBy: req.user?.email ?? 'operator',
      });
    }
    await doc.save();
    res.json(doc.toJSON());
  }),
);

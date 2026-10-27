import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { unauthorized, conflict, notFound } from '../../lib/errors';
import { User, hashPassword, verifyPassword } from '../../models/User';
import { Client } from '../../models/Client';
import { USER_ROLES } from '../../models/enums';
import { asyncHandler, requireAdmin, requireAuth, signToken, validate, type AuthPrincipal } from '../middleware';

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, try again later' },
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post(
  '/login',
  loginLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as z.infer<typeof loginSchema>;
    const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
    if (!user || !user.isActive || !(await verifyPassword(password, user.passwordHash))) {
      throw unauthorized('Invalid email or password');
    }

    let clientName: string | undefined;
    let clientAllowedMenus: string[] | undefined;
    if (user.clientId) {
      const client = await Client.findById(user.clientId).select('name isActive allowedMenus').lean();
      if (!client || !client.isActive) {
        throw unauthorized('Харилцагчийн бүртгэл идэвхгүй байна');
      }
      clientName = client.name;
      if (client.allowedMenus && client.allowedMenus.length > 0) {
        clientAllowedMenus = client.allowedMenus;
      }
    }

    user.lastLoginAt = new Date();
    await user.save();

    const allowedMenus = (user.allowedMenus && user.allowedMenus.length > 0)
      ? user.allowedMenus
      : clientAllowedMenus;

    const principal: AuthPrincipal = {
      id: String(user._id),
      email: user.email,
      role: user.role,
      clientId: user.clientId ? String(user.clientId) : undefined,
      clientName,
      allowedMenus,
    };
    res.json({ token: signToken(principal), user: principal });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user!.id).populate('clientId', 'name businessRegister feePercent');
    if (!user) throw notFound('User not found');
    res.json(user.toJSON());
  }),
);

/** The operator finished (or skipped) the first-run guide. Idempotent. */
authRouter.post(
  '/me/guide-done',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findByIdAndUpdate(
      req.user!.id,
      { $unset: { guidePending: 1 } },
      { new: true },
    );
    if (!user) throw notFound('User not found');
    res.json(user.toJSON());
  }),
);

authRouter.delete(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findByIdAndUpdate(req.user!.id, { isActive: false }, { new: true });
    if (!user) throw notFound('User not found');
    res.status(200).json({ ok: true, message: 'Account deactivated' });
  }),
);

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().optional(),
  role: z.enum(USER_ROLES).default('VIEWER'),
  clientId: z.string().optional().nullable(),
  allowedMenus: z.array(z.string()).optional().nullable(),
});

authRouter.post(
  '/users',
  requireAuth,
  requireAdmin,
  validate(createUserSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createUserSchema>;
    const exists = await User.exists({ email: body.email.toLowerCase() });
    if (exists) throw conflict('A user with that email already exists');

    const user = await User.create({
      email: body.email.toLowerCase(),
      passwordHash: await hashPassword(body.password),
      name: body.name,
      role: body.role,
      clientId: body.clientId || undefined,
      allowedMenus: body.allowedMenus && body.allowedMenus.length > 0 ? body.allowedMenus : undefined,
      guidePending: true,
    });
    res.status(201).json(user.toJSON());
  }),
);

authRouter.get(
  '/users',
  requireAuth,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await User.find().populate('clientId', 'name businessRegister').sort({ createdAt: -1 }));
  }),
);

const updateUserSchema = z.object({
  name: z.string().optional(),
  role: z.enum(USER_ROLES).optional(),
  clientId: z.union([z.string(), z.record(z.any())]).optional().nullable(),
  allowedMenus: z.array(z.string()).optional().nullable(),
  isActive: z.boolean().optional(),
  password: z.string().min(6).optional(),
});

authRouter.patch(
  '/users/:id',
  requireAuth,
  requireAdmin,
  validate(updateUserSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updateUserSchema>;
    const update: Record<string, unknown> = {};
    if (body.name !== undefined) update.name = body.name;
    if (body.role !== undefined) update.role = body.role;
    if (body.clientId !== undefined) {
      let cid: string | null = null;
      if (typeof body.clientId === 'string') {
        const trimmed = body.clientId.trim();
        cid = trimmed && trimmed !== '[object Object]' ? trimmed : null;
      } else if (body.clientId && typeof body.clientId === 'object') {
        cid = (body.clientId as any)._id || (body.clientId as any).id || null;
      }
      update.clientId = cid;
    }
    if (body.allowedMenus !== undefined) {
      update.allowedMenus = body.allowedMenus && body.allowedMenus.length > 0 ? body.allowedMenus : [];
    }
    if (body.isActive !== undefined) update.isActive = body.isActive;
    if (body.password) update.passwordHash = await hashPassword(body.password);

    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true }).populate('clientId', 'name businessRegister');
    if (!user) throw notFound('User not found');
    res.json(user.toJSON());
  }),
);

authRouter.delete(
  '/users/:id',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) throw notFound('User not found');
    res.status(204).end();
  }),
);

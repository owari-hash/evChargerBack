import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { unauthorized, conflict, notFound } from '../../lib/errors';
import { User, hashPassword, verifyPassword } from '../../models/User';
import { USER_ROLES } from '../../models/enums';
import { asyncHandler, requireAdmin, requireAuth, signToken, validate } from '../middleware';

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
    user.lastLoginAt = new Date();
    await user.save();

    const principal = { id: String(user._id), email: user.email, role: user.role };
    res.json({ token: signToken(principal), user: principal });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user!.id);
    if (!user) throw notFound('User not found');
    res.json(user.toJSON());
  }),
);

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
  role: z.enum(USER_ROLES).default('VIEWER'),
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
    });
    res.status(201).json(user.toJSON());
  }),
);

authRouter.get(
  '/users',
  requireAuth,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await User.find().sort({ createdAt: -1 }));
  }),
);

const updateUserSchema = z.object({
  name: z.string().optional(),
  role: z.enum(USER_ROLES).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(8).optional(),
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
    if (body.isActive !== undefined) update.isActive = body.isActive;
    if (body.password) update.passwordHash = await hashPassword(body.password);

    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true });
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

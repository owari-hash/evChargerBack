import express, { Router } from 'express';
import { sessionSecret } from './config';
import { driverErrorHandler, driverLogger } from './http';
import { accountRoutes } from './routes/account';
import { appRoutes } from './routes/app';
import { assistantRouter } from './routes/assistant';
import { authRoutes } from './routes/auth';
import { sessionRoutes, stationRoutes, walletRoutes } from './routes/charging';
import { driverNotificationsRoutes } from './routes/notifications';
import { paymentRoutes } from './routes/payments';
import { recordAccess } from '../services/analytics.service';

/**
 * The driver API, mounted at DRIVER_API_BASE_PATH (`/app-api`).
 *
 * It serves the kiosk web app and the Flutter app. Unlike `/api`, callers are
 * drivers signed in with the `evapp_session` cookie, not operators with a JWT,
 * so nothing here goes through `requireAuth`.
 */
export function createDriverRouter(): Router {
  try {
    sessionSecret();
  } catch (err) {
    driverLogger.error({ err }, 'driver sign-in will fail until SESSION_SECRET is set');
  }

  const router = Router();

  // Parsed here rather than by the app-wide parser, so a malformed body gets
  // this API's error envelope.
  router.use(express.json({ limit: '1mb' }));

  // Client beacon endpoint from web/mobile app
  router.post('/app/analytics', async (req, res) => {
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
    res.json({ ok: true });
  });

  // Transparent access tracking for mobile app & driver API hits
  router.use((req, _res, next) => {
    const p = req.path || '';
    if (
      req.method === 'GET' &&
      (p.startsWith('/stations') ||
        p.startsWith('/app') ||
        p.startsWith('/account') ||
        p.startsWith('/wallet'))
    ) {
      void recordAccess({}, req);
    }
    next();
  });
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.use('/app', appRoutes);
  router.use('/auth', authRoutes);
  router.use('/account', accountRoutes);
  router.use('/stations', stationRoutes);
  router.use('/sessions', sessionRoutes);
  router.use('/wallet', walletRoutes);
  router.use('/assistant', assistantRouter);
  router.use('/notifications', driverNotificationsRoutes);
  router.use('/payments', paymentRoutes);

  router.use((_req, res) => {
    res.status(404).json({ error: 'Хүсэлт олдсонгүй' });
  });
  router.use(driverErrorHandler);

  return router;
}

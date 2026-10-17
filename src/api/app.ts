import express, { Router, type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import mongoose from 'mongoose';
import pinoHttp from 'pino-http';
import { apiUrl, env, ocppUrl } from '../config/env';
import { createDriverRouter } from '../driver';
import { apiLogger } from '../lib/logger';
import { UPLOADS_ROOT, UPLOADS_URL_PREFIX } from '../lib/uploads';
import { connectionManager } from '../ocpp/manager';
import { SUPPORTED_ACTIONS } from '../ocpp/schemas';
import { errorHandler, notFoundHandler } from './middleware';
import { announcementsRouter } from './routes/announcements.routes';
import { authRouter } from './routes/auth.routes';
import { chargePointsRouter } from './routes/chargePoints.routes';
import { commandsRouter } from './routes/commands.routes';
import { eventsRouter } from './routes/events.routes';
import { idTagsRouter } from './routes/idTags.routes';
import {
  chargingProfilesRouter,
  connectorsRouter,
  jobsRouter,
  meterValuesRouter,
  reservationsRouter,
  statsRouter,
} from './routes/misc.routes';
import { paymentsRouter } from './routes/payments.routes';
import { qpayRouter } from './routes/qpay.routes';
import { securityRouter } from './routes/security.routes';
import { transactionsRouter } from './routes/transactions.routes';
import { walletsRouter } from './routes/wallets.routes';
import { ebarimtMerchantsRouter } from './routes/ebarimt-merchants.routes';
import { appReleasesRouter } from './routes/appReleases.routes';
import { clientsRouter } from './routes/clients.routes';
import { connectorAdminRouter } from './routes/connectors.routes';
import { settlementsRouter } from './routes/settlements.routes';
import { vehicleDetectionsRouter } from './routes/vehicleDetections.routes';

export function createApp(): Express {
  const app = express();
  const base = env.API_BASE_PATH; // '/api' by default

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',').map((s) => s.trim()),
      credentials: true,
    }),
  );
  app.use(
    pinoHttp({
      logger: apiLogger,
      autoLogging: {
        ignore: (req) => {
          const url = req.url ?? '';
          // Ignore high-frequency polling requests so they don't pollute logs
          return (
            url.includes('/live') ||
            url.includes('/wallet') ||
            url.includes('/announcements') ||
            url.includes('/events/stream') ||
            url.includes('/health')
          );
        },
      },
      serializers: {
        req: (req) => ({
          method: req.method,
          url: req.url,
        }),
        res: (res) => ({
          statusCode: res.statusCode,
        }),
      },
      customSuccessMessage: (req, res) => `${req.method} ${req.url} -> ${res.statusCode}`,
      customErrorMessage: (req, res, err) =>
        `${req.method} ${req.url} -> ${res.statusCode} (${err.message})`,
    }),
  );

  // Driver API for the kiosk web app and the Flutter app. Mounted before the
  // app-wide JSON parser because it parses its own bodies (see createDriverRouter).
  app.use(env.DRIVER_API_BASE_PATH, createDriverRouter());

  // Uploaded images (announcements today), served straight off disk — no CDN
  // in front of this yet, so nginx/this process is where the bytes come from.
  app.use(UPLOADS_URL_PREFIX, express.static(UPLOADS_ROOT));

  app.use(express.json({ limit: '2mb' }));

  // ---- Health & discovery (unauthenticated) ----

  const health: express.RequestHandler = (_req, res) => {
    const dbState = mongoose.connection.readyState; // 1 = connected
    res.status(dbState === 1 ? 200 : 503).json({
      status: dbState === 1 ? 'ok' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      database: ['disconnected', 'connected', 'connecting', 'disconnecting'][dbState] ?? 'unknown',
      chargePointsOnline: connectionManager.size,
      timestamp: new Date().toISOString(),
    });
  };

  // Reachable both at the origin root and behind a proxy that only forwards `${base}`.
  app.get('/health', health);

  const api = Router();

  api.get('/health', health);

  api.get('/', (_req, res) => {
    res.json({
      name: 'OCPP 1.6J Central System',
      ocppVersion: '1.6',
      transport: 'JSON over WebSocket',
      securityProfile: env.OCPP_SECURITY_PROFILE,
      baseUrl: apiUrl(),
      websocketUrl: ocppUrl('/{chargePointId}'),
      websocketPath: `${env.OCPP_PATH_PREFIX}/{chargePointId}`,
      supportedActions: SUPPORTED_ACTIONS,
      endpoints: {
        auth: `${base}/auth`,
        chargePoints: `${base}/charge-points`,
        commands: `${base}/charge-points/:id/<command>`,
        connectors: `${base}/connectors`,
        transactions: `${base}/transactions`,
        meterValues: `${base}/meter-values`,
        idTags: `${base}/id-tags`,
        reservations: `${base}/reservations`,
        chargingProfiles: `${base}/charging-profiles`,
        jobs: `${base}/jobs`,
        security: `${base}/security`,
        payments: `${base}/payments`,
        wallets: `${base}/wallets`,
        walletTopUp: `${base}/wallets/:ownerType/:ownerId/topup`,
        qpayCallback: `${base}/payments/callback/:paymentId/:secret`,
        quickQr: `${base}/qpay`,
        appReleases: `${base}/app-releases`,
        announcements: `${base}/announcements`,
        stats: `${base}/stats`,
        eventStream: `${base}/events/stream`,
      },
    });
  });

  // ---- API ----

  api.use('/auth', authRouter);
  api.use('/charge-points', chargePointsRouter);
  api.use('/charge-points', commandsRouter); // POST ${base}/charge-points/:id/<command>
  api.use('/connectors', connectorsRouter);
  api.use('/transactions', transactionsRouter);
  api.use('/meter-values', meterValuesRouter);
  api.use('/id-tags', idTagsRouter);
  api.use('/reservations', reservationsRouter);
  api.use('/charging-profiles', chargingProfilesRouter);
  api.use('/jobs', jobsRouter);
  api.use('/payments', paymentsRouter);
  api.use('/wallets', walletsRouter);
  api.use('/qpay', qpayRouter);
  api.use('/ebarimt-merchants', ebarimtMerchantsRouter);
  api.use('/app-releases', appReleasesRouter);
  api.use('/clients', clientsRouter);
  api.use('/announcements', announcementsRouter);
  // Mounted at the API root: it owns both /charge-points/:id/connectors and /connectors/:id.
  api.use('/', connectorAdminRouter);
  api.use('/settlements', settlementsRouter);
  api.use('/security', securityRouter);
  api.use('/stats', statsRouter);
  api.use('/events', eventsRouter);
  api.use('/vehicle-detections', vehicleDetectionsRouter);

  app.use(base || '/', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import mongoose from 'mongoose';
import pinoHttp from 'pino-http';
import { env } from '../config/env';
import { apiLogger } from '../lib/logger';
import { connectionManager } from '../ocpp/manager';
import { SUPPORTED_ACTIONS } from '../ocpp/schemas';
import { errorHandler, notFoundHandler } from './middleware';
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
import { securityRouter } from './routes/security.routes';
import { transactionsRouter } from './routes/transactions.routes';

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',').map((s) => s.trim()),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(
    pinoHttp({
      logger: apiLogger,
      autoLogging: { ignore: (req) => req.url?.startsWith('/api/events/stream') === true },
    }),
  );

  // ---- Health & discovery (unauthenticated) ----

  app.get('/health', (_req, res) => {
    const dbState = mongoose.connection.readyState; // 1 = connected
    res.status(dbState === 1 ? 200 : 503).json({
      status: dbState === 1 ? 'ok' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      database: ['disconnected', 'connected', 'connecting', 'disconnecting'][dbState] ?? 'unknown',
      chargePointsOnline: connectionManager.size,
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api', (_req, res) => {
    res.json({
      name: 'OCPP 1.6J Central System',
      ocppVersion: '1.6',
      transport: 'JSON over WebSocket',
      securityProfile: env.OCPP_SECURITY_PROFILE,
      websocketPath: `${env.OCPP_PATH_PREFIX}/{chargePointId}`,
      supportedActions: SUPPORTED_ACTIONS,
      endpoints: {
        auth: '/api/auth',
        chargePoints: '/api/charge-points',
        commands: '/api/charge-points/:id/<command>',
        connectors: '/api/connectors',
        transactions: '/api/transactions',
        meterValues: '/api/meter-values',
        idTags: '/api/id-tags',
        reservations: '/api/reservations',
        chargingProfiles: '/api/charging-profiles',
        jobs: '/api/jobs',
        security: '/api/security',
        stats: '/api/stats',
        eventStream: '/api/events/stream',
      },
    });
  });

  // ---- API ----

  app.use('/api/auth', authRouter);
  app.use('/api/charge-points', chargePointsRouter);
  app.use('/api/charge-points', commandsRouter); // POST /api/charge-points/:id/<command>
  app.use('/api/connectors', connectorsRouter);
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/meter-values', meterValuesRouter);
  app.use('/api/id-tags', idTagsRouter);
  app.use('/api/reservations', reservationsRouter);
  app.use('/api/charging-profiles', chargingProfilesRouter);
  app.use('/api/jobs', jobsRouter);
  app.use('/api/security', securityRouter);
  app.use('/api/stats', statsRouter);
  app.use('/api/events', eventsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

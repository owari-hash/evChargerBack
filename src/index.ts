import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { env } from './config/env';
import { connectDatabase, disconnectDatabase } from './lib/db';
import { logger } from './lib/logger';
import { createApp } from './api/app';
import { attachOcppServer } from './ocpp/server';
import { connectionManager } from './ocpp/manager';
import { startMaintenanceJobs, stopMaintenanceJobs } from './services/maintenance.service';

/**
 * Cipher suites required of the Central System by the OCA security white paper,
 * A00.FR.317, expressed with OpenSSL names.
 */
const TLS_CIPHERS = [
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
].join(':');

function buildServer(app: ReturnType<typeof createApp>) {
  if (!env.TLS_ENABLED) {
    if (env.OCPP_SECURITY_PROFILE > 1) {
      logger.warn(
        `OCPP_SECURITY_PROFILE=${env.OCPP_SECURITY_PROFILE} requires TLS, but TLS_ENABLED is false. ` +
          'Terminate TLS at a reverse proxy, or set TLS_ENABLED=true.',
      );
    }
    return http.createServer(app);
  }

  const options: https.ServerOptions = {
    key: readFileSync(env.TLS_KEY_PATH),
    cert: readFileSync(env.TLS_CERT_PATH),
    minVersion: 'TLSv1.2', // A00.FR.312
    ciphers: TLS_CIPHERS,
    honorCipherOrder: true,
  };

  // Security profile 3: mutual TLS with charge point client certificates.
  if (env.OCPP_SECURITY_PROFILE === 3) {
    options.ca = readFileSync(env.TLS_CA_PATH);
    options.requestCert = true;
    options.rejectUnauthorized = true;
  }

  return https.createServer(options, app);
}

async function main(): Promise<void> {
  await connectDatabase();

  const app = createApp();
  const server = buildServer(app);

  attachOcppServer(server);
  startMaintenanceJobs();

  server.listen(env.HTTP_PORT, env.HTTP_HOST, () => {
    const scheme = env.TLS_ENABLED ? 'https' : 'http';
    const wsScheme = env.TLS_ENABLED ? 'wss' : 'ws';
    logger.info(
      `Central System listening on ${scheme}://${env.HTTP_HOST}:${env.HTTP_PORT}  |  ` +
        `charge points: ${wsScheme}://<host>:${env.HTTP_PORT}${env.OCPP_PATH_PREFIX}/{chargePointId}  |  ` +
        `security profile ${env.OCPP_SECURITY_PROFILE}`,
    );
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    stopMaintenanceJobs();
    connectionManager.closeAll();
    server.close(() => {
      void disconnectDatabase().finally(() => process.exit(0));
    });
    // Do not hang forever on lingering sockets.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandled rejection'));
  process.on('uncaughtException', (err) => logger.error({ err }, 'uncaught exception'));
}

void main().catch((err) => {
  logger.error({ err }, 'failed to start');
  process.exit(1);
});

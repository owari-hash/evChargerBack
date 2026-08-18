import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import bcrypt from 'bcryptjs';
import { WebSocketServer, type WebSocket } from 'ws';
import { env } from '../config/env';
import { ocppLogger } from '../lib/logger';
import { ChargePoint } from '../models/ChargePoint';
import { bus } from '../realtime/events';
import { recordSecurityEvent } from '../services/security.service';
import { ChargePointConnection } from './connection';
import { handleInboundCall } from './handlers';
import { connectionManager } from './manager';
import type { ConnectionContext } from './types';

const SUBPROTOCOL = 'ocpp1.6';

interface AuthResult {
  ok: boolean;
  status?: number;
  message?: string;
  securityEvent?: string;
}

function parseChargePointId(url: string | undefined): string | null {
  if (!url) return null;
  const path = url.split('?')[0]!;
  const prefix = env.OCPP_PATH_PREFIX.replace(/\/$/, '');
  if (prefix && !path.startsWith(prefix + '/')) return null;
  const rest = prefix ? path.slice(prefix.length + 1) : path.replace(/^\//, '');
  const id = decodeURIComponent(rest.split('/')[0] ?? '');
  // Charge point identities are used as document ids; keep them tame.
  if (!id || id.length > 64 || !/^[\w.:@-]+$/.test(id)) return null;
  return id;
}

function parseBasicAuth(header: string | undefined): { user: string; pass: string } | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'basic' || !value) return null;
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
}

/**
 * Authenticate the upgrade request according to the configured security profile.
 *
 * Profile 1/2: HTTP Basic, username = charge point identity (A00.FR.204 / 303),
 *              password = AuthorizationKey (A00.FR.205 / 304).
 * Profile 3:   TLS client certificate; the certificate CN must equal the
 *              charge point identity (A00.FR.405 / 412).
 */
async function authenticate(req: IncomingMessage, chargePointId: string): Promise<AuthResult> {
  const cp = await ChargePoint.findById(chargePointId).select('+authorizationKeyHash').lean();

  if (env.OCPP_REQUIRE_KNOWN_CHARGEPOINT && !cp) {
    return { ok: false, status: 404, message: 'Unknown charge point' };
  }
  if (cp && cp.isEnabled === false) {
    return { ok: false, status: 403, message: 'Charge point is disabled' };
  }

  if (env.OCPP_SECURITY_PROFILE === 3) {
    const socket = req.socket as TLSSocket;
    if (typeof socket.getPeerCertificate !== 'function' || !socket.authorized) {
      return {
        ok: false,
        status: 401,
        message: 'Client certificate required',
        securityEvent: 'InvalidChargePointCertificate',
      };
    }
    const cert = socket.getPeerCertificate();
    const cn = cert?.subject?.CN;
    if (!cn || cn !== chargePointId) {
      return {
        ok: false,
        status: 403,
        message: 'Client certificate CN does not match the charge point identity',
        securityEvent: 'InvalidChargePointCertificate',
      };
    }
    return { ok: true };
  }

  // Profiles 1 and 2 -> HTTP Basic
  const basic = parseBasicAuth(req.headers.authorization);
  if (!basic) {
    if (env.OCPP_ALLOW_ANONYMOUS && !cp?.authorizationKeyHash) return { ok: true };
    return { ok: false, status: 401, message: 'Authorization required' };
  }
  if (basic.user !== chargePointId) {
    return {
      ok: false,
      status: 401,
      message: 'Basic auth username must equal the charge point identity',
      securityEvent: 'FailedToAuthenticateAtCentralSystem',
    };
  }
  if (!cp?.authorizationKeyHash) {
    // No key provisioned yet. Allow only when anonymous connections are enabled.
    if (env.OCPP_ALLOW_ANONYMOUS) return { ok: true };
    return { ok: false, status: 401, message: 'No AuthorizationKey provisioned' };
  }
  const ok = await bcrypt.compare(basic.pass, cp.authorizationKeyHash);
  if (!ok) {
    return {
      ok: false,
      status: 401,
      message: 'Invalid credentials',
      securityEvent: 'FailedToAuthenticateAtCentralSystem',
    };
  }
  return { ok: true };
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = `${status} ${message}`;
  const headers = [
    `HTTP/1.1 ${body}`,
    'Connection: close',
    'Content-Length: 0',
    status === 401 ? 'WWW-Authenticate: Basic realm="OCPP", charset="UTF-8"' : '',
    '',
    '',
  ]
    .filter(Boolean)
    .join('\r\n');
  socket.write(headers);
  socket.destroy();
}

export function attachOcppServer(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: () => SUBPROTOCOL });

  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const chargePointId = parseChargePointId(req.url);
      if (!chargePointId) {
        // Not an OCPP path; let other upgrade handlers (if any) deal with it.
        rejectUpgrade(socket, 404, 'Not Found');
        return;
      }

      const offered = (req.headers['sec-websocket-protocol'] ?? '')
        .toString()
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (offered.length > 0 && !offered.includes(SUBPROTOCOL)) {
        ocppLogger.warn({ cp: chargePointId, offered }, 'unsupported websocket subprotocol');
        rejectUpgrade(socket, 400, 'Unsupported Subprotocol');
        return;
      }

      let auth: AuthResult;
      try {
        auth = await authenticate(req, chargePointId);
      } catch (err) {
        ocppLogger.error({ err, cp: chargePointId }, 'authentication failed with an error');
        rejectUpgrade(socket, 500, 'Internal Server Error');
        return;
      }

      if (!auth.ok) {
        ocppLogger.warn(
          { cp: chargePointId, reason: auth.message },
          'rejecting charge point connection',
        );
        if (auth.securityEvent) {
          void recordSecurityEvent(chargePointId, auth.securityEvent, auth.message, 'CentralSystem');
        }
        rejectUpgrade(socket, auth.status ?? 401, auth.message ?? 'Unauthorized');
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        onConnection(ws, req, chargePointId);
      });
    })();
  });

  return wss;
}

async function onConnection(
  ws: WebSocket,
  req: IncomingMessage,
  chargePointId: string,
): Promise<void> {
  const remoteAddress =
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
    req.socket.remoteAddress ??
    'unknown';

  const context: ConnectionContext = {
    chargePointId,
    remoteAddress,
    securityProfile: env.OCPP_SECURITY_PROFILE,
    protocol: ws.protocol || SUBPROTOCOL,
    connectedAt: new Date(),
  };

  const conn = new ChargePointConnection(ws, context, handleInboundCall);
  connectionManager.add(conn);

  ocppLogger.info({ cp: chargePointId, remoteAddress }, 'charge point connected');

  await ChargePoint.findByIdAndUpdate(
    chargePointId,
    {
      $set: {
        isOnline: true,
        lastSeenAt: new Date(),
        remoteAddress,
        ocppProtocol: context.protocol,
        disconnectedAt: null,
      },
      $setOnInsert: {
        _id: chargePointId,
        registrationStatus: 'Accepted',
        securityProfile: env.OCPP_SECURITY_PROFILE,
        heartbeatInterval: env.OCPP_HEARTBEAT_INTERVAL,
      },
    },
    { upsert: true, new: true },
  ).catch((err) => ocppLogger.error({ err, cp: chargePointId }, 'failed to mark charge point online'));

  bus.emitEvent('chargepoint.connected', chargePointId, { remoteAddress });

  ws.on('close', (code, reason) => {
    connectionManager.remove(chargePointId, conn);
    ocppLogger.info({ cp: chargePointId, code }, 'charge point disconnected');
    void ChargePoint.findByIdAndUpdate(chargePointId, {
      $set: { isOnline: false, disconnectedAt: new Date(), lastSeenAt: new Date() },
    }).catch(() => undefined);
    void markConnectorsUnknown(chargePointId);
    bus.emitEvent('chargepoint.disconnected', chargePointId, {
      code,
      reason: reason.toString(),
    });
  });
}

async function markConnectorsUnknown(chargePointId: string): Promise<void> {
  const { Connector } = await import('../models/Connector');
  await Connector.updateMany(
    { chargePointId, status: { $ne: 'Unavailable' } },
    { $set: { info: 'Charge point offline' } },
  ).catch(() => undefined);
}

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { sessionSecret } from '../driver/config';
import { logger } from '../lib/logger';
import { bus, type CsmsEvent } from './events';
import { store } from '../driver/store';

interface ClientConnection {
  ws: WebSocket;
  userId?: string;
  role: 'admin' | 'driver' | 'anonymous';
  /** Identity came from a verified token or session cookie, not the query string. */
  verified: boolean;
  isAlive: boolean;
}

const clients = new Set<ClientConnection>();

function parseCookies(header?: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    try {
      result[key] = decodeURIComponent(val);
    } catch {
      result[key] = val;
    }
  }
  return result;
}

export function attachNotificationSocketServer(server: HttpServer | HttpsServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const parsedUrl = new URL(req.url ?? '', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    if (
      pathname !== '/ws/notifications' &&
      pathname !== '/ws' &&
      pathname !== '/api/ws/notifications' &&
      pathname !== '/app-api/ws/notifications'
    ) {
      return;
    }

    const token = parsedUrl.searchParams.get('token');
    const cookies = parseCookies(req.headers.cookie);
    let userId: string | undefined = parsedUrl.searchParams.get('userId') ?? undefined;
    let role: 'admin' | 'driver' | 'anonymous' = 'anonymous';
    let verified = false;

    // 1. Check Admin token / cookie
    if (token) {
      try {
        const decoded = jwt.verify(token, env.JWT_SECRET) as { id?: string };
        if (decoded?.id) {
          userId = decoded.id;
          role = 'admin';
          verified = true;
        }
      } catch {
        /* invalid token */
      }
    } else if (cookies['eplug_session']) {
      try {
        const decoded = jwt.verify(cookies['eplug_session'], env.JWT_SECRET) as { id?: string };
        if (decoded?.id) {
          userId = decoded.id;
          role = 'admin';
          verified = true;
        }
      } catch {
        /* ignore */
      }
    }

    // 2. Check Driver session cookie
    if (role === 'anonymous' && cookies[env.SESSION_COOKIE_NAME]) {
      try {
        const payload = jwt.verify(cookies[env.SESSION_COOKIE_NAME], sessionSecret(), {
          algorithms: ['HS256'],
        }) as { sub?: string };
        if (payload?.sub) {
          userId = payload.sub;
          role = 'driver';
          verified = true;
        }
      } catch {
        /* ignore */
      }
    }

    if (role === 'anonymous' && userId) {
      role = parsedUrl.searchParams.get('role') === 'admin' ? 'admin' : 'driver';
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const client: ClientConnection = {
        ws,
        userId,
        role,
        verified,
        isAlive: true,
      };
      clients.add(client);

      ws.on('pong', () => {
        client.isAlive = true;
      });

      ws.on('close', () => {
        clients.delete(client);
      });

      ws.on('error', () => {
        clients.delete(client);
      });

      // Send initial ready message
      ws.send(
        JSON.stringify({
          type: 'ready',
          userId,
          role,
          at: new Date().toISOString(),
        }),
      );
    });
  });

  // Heartbeat ping every 30s
  const interval = setInterval(() => {
    for (const client of clients) {
      if (!client.isAlive) {
        client.ws.terminate();
        clients.delete(client);
        continue;
      }
      client.isAlive = false;
      client.ws.ping();
    }
  }, 30_000);

  wss.on('close', () => clearInterval(interval));

  // Listen to CSMS bus events and forward relevant events to sockets
  bus.onAny((event: CsmsEvent) => {
    void broadcastLiveEvent(event).catch((err) =>
      logger.warn({ err, event: event.event }, 'failed to forward live event'),
    );
  });

  return wss;
}

export function broadcastNotification(
  target: { userId?: string; role?: 'admin' | 'driver' | 'all' },
  notification: unknown,
): void {
  const payload = JSON.stringify({
    type: 'notification',
    data: notification,
    at: new Date().toISOString(),
  });

  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (target.userId && client.userId && client.userId !== target.userId) continue;
    if (target.role && target.role !== 'all' && client.role !== 'anonymous' && client.role !== target.role) {
      continue;
    }
    try {
      client.ws.send(payload);
    } catch (err) {
      logger.warn({ err }, 'failed to send notification over websocket');
    }
  }
}

/** CSMS events a driver may see about themselves. */
const DRIVER_EVENTS = new Set<string>([
  'wallet.credited',
  'wallet.debited',
  'transaction.started',
  'transaction.stopped',
]);

/**
 * The signed-in driver a live event is about, or undefined when it is about
 * no driver. Wallet events carry the owner; charge events only the tag.
 */
async function driverFor(event: CsmsEvent): Promise<string | undefined> {
  if (!DRIVER_EVENTS.has(event.event)) return undefined;
  const data = (event.data ?? {}) as { ownerType?: string; ownerId?: unknown; idTag?: unknown };
  if (event.event.startsWith('wallet.')) {
    return data.ownerType === 'USER' && data.ownerId != null ? String(data.ownerId) : undefined;
  }
  if (typeof data.idTag !== 'string' || !data.idTag) return undefined;
  const user = await store.findUserByIdTag(data.idTag);
  return user?.id ? String(user.id) : undefined;
}

/**
 * Every event goes to signed-in operators. A driver gets only their own
 * wallet and charge events, and only on a socket opened with their session
 * cookie: these used to go to every connection, so anyone could read every
 * driver's balance and charges by opening the socket.
 */
async function broadcastLiveEvent(event: CsmsEvent): Promise<void> {
  const payload = JSON.stringify({
    type: 'event',
    event: event.event,
    chargePointId: event.chargePointId,
    at: event.at,
    data: event.data,
  });

  const hasDrivers = [...clients].some((c) => c.verified && c.role === 'driver');
  const driverId = hasDrivers ? await driverFor(event) : undefined;

  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN || !client.verified) continue;
    const allowed =
      client.role === 'admin' || (client.role === 'driver' && driverId !== undefined && client.userId === driverId);
    if (!allowed) continue;
    try {
      client.ws.send(payload);
    } catch {
      /* ignore */
    }
  }
}

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
const adminClients = new Set<ClientConnection>();
const driverClients = new Map<string, Set<ClientConnection>>();

function addClient(client: ClientConnection): void {
  clients.add(client);
  if (client.verified) {
    if (client.role === 'admin') {
      adminClients.add(client);
    } else if (client.role === 'driver' && client.userId) {
      let userSet = driverClients.get(client.userId);
      if (!userSet) {
        userSet = new Set();
        driverClients.set(client.userId, userSet);
      }
      userSet.add(client);
    }
  }
}

function removeClient(client: ClientConnection): void {
  clients.delete(client);
  adminClients.delete(client);
  if (client.userId) {
    const userSet = driverClients.get(client.userId);
    if (userSet) {
      userSet.delete(client);
      if (userSet.size === 0) {
        driverClients.delete(client.userId);
      }
    }
  }
}

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
      addClient(client);

      ws.on('pong', () => {
        client.isAlive = true;
      });

      ws.on('close', () => {
        removeClient(client);
      });

      ws.on('error', () => {
        removeClient(client);
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
        removeClient(client);
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

  const sendTo = (client: ClientConnection) => {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    try {
      client.ws.send(payload);
    } catch (err) {
      logger.warn({ err }, 'failed to send notification over websocket');
    }
  };

  if (target.role === 'admin') {
    for (const client of adminClients) sendTo(client);
    return;
  }

  if (target.userId) {
    const userSockets = driverClients.get(target.userId);
    if (userSockets) {
      for (const client of userSockets) sendTo(client);
    }
    for (const client of adminClients) {
      if (client.userId === target.userId) sendTo(client);
    }
    return;
  }

  for (const client of clients) {
    if (target.role && target.role !== 'all' && client.role !== 'anonymous' && client.role !== target.role) {
      continue;
    }
    sendTo(client);
  }
}

/** CSMS events a driver may see about themselves. */
const DRIVER_EVENTS = new Set<string>([
  'wallet.credited',
  'wallet.debited',
  'transaction.started',
  'transaction.stopped',
]);

const idTagUserCache = new Map<string, { userId: string | undefined; expiresAt: number }>();

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

  const now = Date.now();
  const cached = idTagUserCache.get(data.idTag);
  if (cached && cached.expiresAt > now) {
    return cached.userId;
  }

  const user = await store.findUserByIdTag(data.idTag);
  const resolved = user?.id ? String(user.id) : undefined;

  if (idTagUserCache.size > 2000) idTagUserCache.clear();
  idTagUserCache.set(data.idTag, { userId: resolved, expiresAt: now + 5 * 60_000 });
  return resolved;
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

  // 1. All verified admins receive every event directly
  for (const client of adminClients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(payload);
      } catch {
        /* ignore */
      }
    }
  }

  // 2. Drivers only receive their own wallet and charge events
  if (driverClients.size > 0 && DRIVER_EVENTS.has(event.event)) {
    const driverId = await driverFor(event);
    if (driverId) {
      const userSockets = driverClients.get(driverId);
      if (userSockets) {
        for (const client of userSockets) {
          if (client.ws.readyState === WebSocket.OPEN) {
            try {
              client.ws.send(payload);
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
  }
}

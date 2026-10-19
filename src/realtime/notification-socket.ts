import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { sessionSecret } from '../driver/config';
import { logger } from '../lib/logger';
import { bus, type CsmsEvent } from './events';

interface ClientConnection {
  ws: WebSocket;
  userId?: string;
  role: 'admin' | 'driver' | 'anonymous';
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

    // 1. Check Admin token / cookie
    if (token) {
      try {
        const decoded = jwt.verify(token, env.JWT_SECRET) as { id?: string };
        if (decoded?.id) {
          userId = decoded.id;
          role = 'admin';
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
    broadcastLiveEvent(event);
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

function broadcastLiveEvent(event: CsmsEvent): void {
  const payload = JSON.stringify({
    type: 'event',
    event: event.event,
    chargePointId: event.chargePointId,
    at: event.at,
    data: event.data,
  });

  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    try {
      client.ws.send(payload);
    } catch {
      /* ignore */
    }
  }
}

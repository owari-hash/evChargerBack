import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { findChargePoint } from '../../lib/chargePointRef';
import { bus, type CsmsEvent } from '../../realtime/events';
import { asyncHandler } from '../middleware';
import type { AuthPrincipal } from '../middleware/auth';

export const eventsRouter = Router();

/**
 * Server-Sent Events stream of live CSMS activity.
 *
 * EventSource cannot set request headers, so the JWT may also be passed as
 * `?token=` (or the API key as `?apiKey=`).
 *
 *   const es = new EventSource('/api/events/stream?token=' + jwt);
 *   es.onmessage = (e) => console.log(JSON.parse(e.data));
 *
 * Optional filters: ?chargePointId=CP1&events=transaction.started,connector.status
 * The filter takes either identifier — the console holds an ObjectId from a
 * previous response, while the events themselves are labelled with the OCPP id.
 */
eventsRouter.get(
  '/stream',
  asyncHandler(async (req, res) => {
    const token = (req.query.token as string | undefined) ?? bearer(req.header('authorization'));
    const apiKey = (req.query.apiKey as string | undefined) ?? req.header('x-api-key');

    let principal: AuthPrincipal | undefined;
    if (env.API_KEY && apiKey === env.API_KEY) {
      principal = { id: 'api-key', email: 'api-key', role: 'ADMIN' };
    } else if (token) {
      try {
        principal = jwt.verify(token, env.JWT_SECRET) as AuthPrincipal;
      } catch {
        /* fall through */
      }
    }
    if (!principal) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Events carry the OCPP identifier, so resolve whatever the caller passed to
    // that. Resolved once here rather than per event: a rename mid-stream is rare
    // and the subscription is already scoped to the station the caller opened.
    const filter = req.query.chargePointId as string | undefined;
    let cpId: string | undefined;
    if (filter) {
      const cp = await findChargePoint(filter);
      if (!cp) {
        res.status(404).json({ error: 'Charge point not found' });
        return;
      }
      cpId = cp.cpId;
    }

    const wanted = (req.query.events as string | undefined)
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 5000\n\n`);
    res.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

    const send = (e: CsmsEvent) => {
      if (cpId && e.chargePointId !== cpId) return;
    if (wanted && wanted.length > 0 && !wanted.includes(e.event)) return;
    res.write(`event: ${e.event}\ndata: ${JSON.stringify(e)}\n\n`);
  };

  const off = bus.onAny(send);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);

    req.on('close', () => {
      clearInterval(keepAlive);
      off();
      res.end();
    });
  }),
);

function bearer(header?: string): string | undefined {
  if (!header?.toLowerCase().startsWith('bearer ')) return undefined;
  return header.slice(7).trim();
}

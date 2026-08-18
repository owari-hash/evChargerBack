import { SecurityEvent } from '../models/Security';
import { isCriticalSecurityEvent } from '../models/enums';
import { bus } from '../realtime/events';
import { logger } from '../lib/logger';

/**
 * Persist a security event (white paper section 8). Used both for events pushed
 * by charge points via SecurityEventNotification.req and for events the Central
 * System detects itself (e.g. a failed authentication on the WebSocket upgrade).
 */
export async function recordSecurityEvent(
  chargePointId: string,
  type: string,
  techInfo?: string,
  source: 'ChargePoint' | 'CentralSystem' = 'ChargePoint',
  timestamp: Date = new Date(),
): Promise<void> {
  const isCritical = isCriticalSecurityEvent(type);
  try {
    const doc = await SecurityEvent.create({
      chargePointId,
      type,
      timestamp,
      techInfo: techInfo?.slice(0, 255),
      isCritical,
      source,
    });
    bus.emitEvent('security.event', chargePointId, {
      id: String(doc._id),
      type,
      timestamp,
      techInfo,
      isCritical,
      source,
    });
    if (isCritical) {
      logger.warn({ cp: chargePointId, type, techInfo }, 'critical security event');
    }
  } catch (err) {
    logger.error({ err, cp: chargePointId, type }, 'failed to record security event');
  }
}

import { ChargePoint } from '../models/ChargePoint';
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
  /** The OCPP identifier presented, which is recorded even when it is unknown. */
  cpId: string,
  type: string,
  techInfo?: string,
  source: 'ChargePoint' | 'CentralSystem' = 'ChargePoint',
  timestamp: Date = new Date(),
): Promise<void> {
  const isCritical = isCriticalSecurityEvent(type);
  try {
    // A station that failed to authenticate may not exist, so the reference is
    // best-effort while `cpId` is always kept.
    const cp = await ChargePoint.findOne({ cpId }).select('_id').lean();
    const doc = await SecurityEvent.create({
      chargePointId: cp?._id,
      cpId,
      type,
      timestamp,
      techInfo: techInfo?.slice(0, 255),
      isCritical,
      source,
    });
    bus.emitEvent('security.event', cpId, {
      id: String(doc._id),
      type,
      timestamp,
      techInfo,
      isCritical,
      source,
    });
    if (isCritical) {
      logger.warn({ cp: cpId, type, techInfo }, 'critical security event');
    }
  } catch (err) {
    logger.error({ err, cp: cpId, type }, 'failed to record security event');
  }
}

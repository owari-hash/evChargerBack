import { env } from '../config/env';
import { logger } from '../lib/logger';
import { ChargePoint } from '../models/ChargePoint';
import { Reservation } from '../models/Reservation';
import { connectionManager } from '../ocpp/manager';
import { Payment } from '../models/Payment';
import { reconcilePendingPayments } from './payment.service';

let timers: NodeJS.Timeout[] = [];

/**
 * Mark charge points offline when they stop sending heartbeats.
 *
 * The socket may stay half-open behind a NAT or mobile link, so a missed
 * heartbeat is a more reliable liveness signal than the TCP state alone.
 */
async function sweepOfflineChargePoints(): Promise<void> {
  const online = new Set(connectionManager.onlineIds());
  const candidates = await ChargePoint.find({ isOnline: true })
    .select('_id heartbeatInterval lastSeenAt')
    .lean();

  const now = Date.now();
  const stale: string[] = [];

  for (const cp of candidates) {
    if (online.has(cp._id)) continue;
    const grace = (cp.heartbeatInterval || env.OCPP_HEARTBEAT_INTERVAL) * 2 * 1000;
    const last = cp.lastSeenAt?.getTime() ?? 0;
    if (now - last > grace) stale.push(cp._id);
  }

  if (stale.length > 0) {
    await ChargePoint.updateMany(
      { _id: { $in: stale } },
      { $set: { isOnline: false, disconnectedAt: new Date() } },
    );
    logger.info({ count: stale.length }, 'marked charge points offline');
  }
}

/** Expire reservations whose expiryDate has passed. */
async function expireReservations(): Promise<void> {
  const result = await Reservation.updateMany(
    { state: 'Active', expiryDate: { $lte: new Date() } },
    { $set: { state: 'Expired' } },
  );
  if (result.modifiedCount > 0) {
    logger.info({ count: result.modifiedCount }, 'expired reservations');
  }
}

/**
 * Reconcile QPay invoices we never got a callback for, and retire the ones that
 * are past their expiry so they stop being polled forever.
 */
async function reconcileQpayPayments(): Promise<void> {
  if (!env.QPAY_ENABLED) return;

  const expired = await Payment.updateMany(
    { status: 'PENDING', paidAmount: { $lte: 0 }, expiresAt: { $lte: new Date() } },
    { $set: { status: 'EXPIRED' } },
  );
  if (expired.modifiedCount > 0) {
    logger.info({ count: expired.modifiedCount }, 'expired qpay invoices');
  }

  const result = await reconcilePendingPayments(50);
  if (result.paid > 0) {
    logger.info(result, 'qpay reconciliation settled payments');
  }
}

export function startMaintenanceJobs(): void {
  const run = (fn: () => Promise<void>, everyMs: number) => {
    const t = setInterval(() => {
      void fn().catch((err) => logger.error({ err }, 'maintenance job failed'));
    }, everyMs);
    t.unref();
    timers.push(t);
  };

  run(sweepOfflineChargePoints, 60_000);
  run(expireReservations, 60_000);
  if (env.QPAY_ENABLED) run(reconcileQpayPayments, 120_000);
}

export function stopMaintenanceJobs(): void {
  for (const t of timers) clearInterval(t);
  timers = [];
}

import { ocppLogger } from '../lib/logger';
import { serviceUnavailable } from '../lib/errors';
import type { ChargePointConnection } from './connection';
import type { OcppAction } from './schemas';

/**
 * Registry of live charge point connections for this process.
 *
 * Note: this is in-memory. If you run more than one API instance behind a load
 * balancer, either pin charge points to one instance or add a message broker so
 * a REST call landing on instance A can reach a socket held by instance B.
 */
class ConnectionManager {
  private readonly connections = new Map<string, ChargePointConnection>();

  add(conn: ChargePointConnection): void {
    const existing = this.connections.get(conn.chargePointId);
    if (existing && existing !== conn) {
      ocppLogger.info(
        { cp: conn.chargePointId },
        'replacing existing connection for charge point',
      );
      existing.close(1000, 'Superseded by a new connection');
    }
    this.connections.set(conn.chargePointId, conn);
  }

  remove(chargePointId: string, conn?: ChargePointConnection): void {
    const current = this.connections.get(chargePointId);
    if (!current) return;
    if (conn && current !== conn) return; // a newer connection already took over
    this.connections.delete(chargePointId);
  }

  get(chargePointId: string): ChargePointConnection | undefined {
    const c = this.connections.get(chargePointId);
    return c?.isOpen ? c : undefined;
  }

  isOnline(chargePointId: string): boolean {
    return this.get(chargePointId) !== undefined;
  }

  onlineIds(): string[] {
    return [...this.connections.entries()].filter(([, c]) => c.isOpen).map(([id]) => id);
  }

  get size(): number {
    return this.onlineIds().length;
  }

  /** Send a command to a charge point, or throw 503 if it is not connected. */
  async send<T = unknown>(
    chargePointId: string,
    action: OcppAction | string,
    payload: unknown,
    issuedBy?: string,
  ): Promise<T> {
    const conn = this.get(chargePointId);
    if (!conn) {
      throw serviceUnavailable(`Charge point ${chargePointId} is not connected`);
    }
    return conn.call<T>(action, payload, issuedBy);
  }

  closeAll(reason = 'Central System shutting down'): void {
    for (const conn of this.connections.values()) conn.close(1001, reason);
    this.connections.clear();
  }
}

export const connectionManager = new ConnectionManager();

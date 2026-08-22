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
    const existing = this.connections.get(conn.cpId);
    if (existing && existing !== conn) {
      ocppLogger.info(
        { cp: conn.cpId },
        'replacing existing connection for charge point',
      );
      existing.close(1000, 'Superseded by a new connection');
    }
    this.connections.set(conn.cpId, conn);
  }

  remove(cpId: string, conn?: ChargePointConnection): void {
    const current = this.connections.get(cpId);
    if (!current) return;
    if (conn && current !== conn) return; // a newer connection already took over
    this.connections.delete(cpId);
  }

  get(cpId: string): ChargePointConnection | undefined {
    const c = this.connections.get(cpId);
    return c?.isOpen ? c : undefined;
  }

  isOnline(cpId: string): boolean {
    return this.get(cpId) !== undefined;
  }

  /** OCPP identifiers of every station currently connected. */
  onlineCpIds(): string[] {
    return [...this.connections.entries()].filter(([, c]) => c.isOpen).map(([id]) => id);
  }

  get size(): number {
    return this.onlineCpIds().length;
  }

  /** Send a command to a charge point, or throw 503 if it is not connected. */
  async send<T = unknown>(
    cpId: string,
    action: OcppAction | string,
    payload: unknown,
    issuedBy?: string,
  ): Promise<T> {
    const conn = this.get(cpId);
    if (!conn) {
      throw serviceUnavailable(`Charge point ${cpId} is not connected`);
    }
    return conn.call<T>(action, payload, issuedBy);
  }

  closeAll(reason = 'Central System shutting down'): void {
    for (const conn of this.connections.values()) conn.close(1001, reason);
    this.connections.clear();
  }
}

export const connectionManager = new ConnectionManager();

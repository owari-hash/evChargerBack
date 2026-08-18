import { EventEmitter } from 'node:events';

export type CsmsEventName =
  | 'chargepoint.connected'
  | 'chargepoint.disconnected'
  | 'chargepoint.boot'
  | 'chargepoint.heartbeat'
  | 'connector.status'
  | 'transaction.started'
  | 'transaction.stopped'
  | 'transaction.metervalue'
  | 'security.event'
  | 'firmware.status'
  | 'diagnostics.status'
  | 'log.status'
  | 'command.result'
  | 'ocpp.message';

export interface CsmsEvent {
  event: CsmsEventName;
  chargePointId?: string;
  at: string;
  data: unknown;
}

class CsmsEventBus extends EventEmitter {
  emitEvent(event: CsmsEventName, chargePointId: string | undefined, data: unknown): void {
    const payload: CsmsEvent = {
      event,
      chargePointId,
      at: new Date().toISOString(),
      data,
    };
    this.emit(event, payload);
    this.emit('*', payload);
  }

  onAny(listener: (e: CsmsEvent) => void): () => void {
    this.on('*', listener);
    return () => this.off('*', listener);
  }
}

export const bus = new CsmsEventBus();
bus.setMaxListeners(0);

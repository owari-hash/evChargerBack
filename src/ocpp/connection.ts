import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { env } from '../config/env';
import { ocppLogger } from '../lib/logger';
import { OcppMessageLog, CommandLog } from '../models/Log';
import { bus } from '../realtime/events';
import { getMessageDefinition, type OcppAction } from './schemas';
import {
  CallTimeoutError,
  MessageType,
  OcppRpcError,
  RpcErrorCode,
  type ConnectionContext,
  type OcppFrame,
} from './types';

export type InboundHandler = (
  action: string,
  payload: unknown,
  conn: ChargePointConnection,
) => Promise<unknown>;

interface PendingCall {
  action: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  startedAt: number;
  commandLogId?: string;
}

interface QueuedCall {
  action: string;
  payload: unknown;
  issuedBy?: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * One live OCPP-J WebSocket connection to a charge point.
 *
 * OCPP-J allows only one outstanding CALL per direction, so outbound calls are
 * serialised through a queue.
 */
export class ChargePointConnection {
  readonly chargePointId: string;
  readonly context: ConnectionContext;

  private readonly socket: WebSocket;
  private readonly handler: InboundHandler;
  private readonly pending = new Map<string, PendingCall>();
  private readonly queue: QueuedCall[] = [];
  private inFlight = false;
  private isAlive = true;
  private pingTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(socket: WebSocket, context: ConnectionContext, handler: InboundHandler) {
    this.socket = socket;
    this.context = context;
    this.chargePointId = context.chargePointId;
    this.handler = handler;

    socket.on('message', (raw) => void this.onMessage(raw.toString()));
    socket.on('close', (code, reason) => this.onClose(code, reason.toString()));
    socket.on('error', (err) => ocppLogger.warn({ err, cp: this.chargePointId }, 'socket error'));
    socket.on('pong', () => {
      this.isAlive = true;
    });

    this.startPing();
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.readyState === this.socket.OPEN;
  }

  // -------------------------------------------------------------------------
  // Outbound: Central System -> Charge Point
  // -------------------------------------------------------------------------

  /**
   * Send a CALL and resolve with the validated CALLRESULT payload.
   * Throws OcppRpcError on CALLERROR and CallTimeoutError on timeout.
   */
  async call<T = unknown>(action: OcppAction | string, payload: unknown, issuedBy?: string): Promise<T> {
    if (!this.isOpen) {
      throw new Error(`Charge point ${this.chargePointId} is not connected`);
    }
    const def = getMessageDefinition(action);
    if (!def) throw new Error(`Unknown OCPP action: ${action}`);
    if (def.origin === 'CP') {
      throw new Error(`${action} may only be sent by the charge point`);
    }

    const parsed = def.req.safeParse(payload ?? {});
    if (!parsed.success) {
      throw new OcppRpcError(
        RpcErrorCode.FormationViolation,
        `Invalid ${action} request payload`,
        parsed.error.flatten(),
      );
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        action,
        payload,
        issuedBy,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      void this.drainQueue();
    });
  }

  private async drainQueue(): Promise<void> {
    if (this.inFlight) return;
    const next = this.queue.shift();
    if (!next) return;

    this.inFlight = true;
    const uniqueId = randomUUID();
    const frame: OcppFrame = [MessageType.CALL, uniqueId, next.action, next.payload ?? {}];

    let commandLogId: string | undefined;
    try {
      const cmd = await CommandLog.create({
        chargePointId: this.chargePointId,
        action: next.action,
        uniqueId,
        request: next.payload ?? {},
        status: 'Sent',
        issuedBy: next.issuedBy,
      });
      commandLogId = String(cmd._id);
    } catch (err) {
      ocppLogger.warn({ err }, 'failed to persist command log');
    }

    const settle = (fn: () => void) => {
      this.pending.delete(uniqueId);
      this.inFlight = false;
      fn();
      void this.drainQueue();
    };

    const timer = setTimeout(() => {
      const p = this.pending.get(uniqueId);
      if (!p) return;
      void this.finishCommandLog(commandLogId, 'TimedOut', undefined, 'timeout', p.startedAt);
      settle(() => next.reject(new CallTimeoutError(next.action, env.OCPP_CALL_TIMEOUT_MS)));
    }, env.OCPP_CALL_TIMEOUT_MS);

    this.pending.set(uniqueId, {
      action: next.action,
      startedAt: Date.now(),
      commandLogId,
      resolve: (value) => settle(() => next.resolve(value)),
      reject: (err) => settle(() => next.reject(err)),
      timer,
    });

    try {
      this.socket.send(JSON.stringify(frame));
      void this.logFrame('OUT', MessageType.CALL, uniqueId, next.action, next.payload ?? {});
    } catch (err) {
      clearTimeout(timer);
      void this.finishCommandLog(commandLogId, 'Failed', undefined, String(err), Date.now());
      settle(() => next.reject(err as Error));
    }
  }

  // -------------------------------------------------------------------------
  // Inbound: Charge Point -> Central System
  // -------------------------------------------------------------------------

  private async onMessage(raw: string): Promise<void> {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      ocppLogger.warn({ cp: this.chargePointId, raw: raw.slice(0, 200) }, 'invalid JSON received');
      this.sendCallError('-1', RpcErrorCode.ProtocolError, 'Message is not valid JSON');
      return;
    }

    if (!Array.isArray(frame) || frame.length < 2 || typeof frame[1] !== 'string') {
      this.sendCallError('-1', RpcErrorCode.ProtocolError, 'Message is not a valid OCPP-J frame');
      return;
    }

    const [messageTypeId, uniqueId] = frame as [number, string];

    switch (messageTypeId) {
      case MessageType.CALL:
        await this.handleCall(uniqueId, frame[2] as string, frame[3]);
        break;
      case MessageType.CALLRESULT:
        this.handleCallResult(uniqueId, frame[2]);
        break;
      case MessageType.CALLERROR:
        this.handleCallError(
          uniqueId,
          String(frame[2] ?? 'GenericError'),
          String(frame[3] ?? ''),
          frame[4],
        );
        break;
      default:
        this.sendCallError(
          uniqueId,
          RpcErrorCode.ProtocolError,
          `Unknown message type id ${messageTypeId}`,
        );
    }
  }

  private async handleCall(uniqueId: string, action: string, payload: unknown): Promise<void> {
    void this.logFrame('IN', MessageType.CALL, uniqueId, action, payload);
    bus.emitEvent('ocpp.message', this.chargePointId, {
      direction: 'IN',
      action,
      uniqueId,
      payload,
    });

    const def = getMessageDefinition(action);
    if (!def) {
      this.sendCallError(uniqueId, RpcErrorCode.NotImplemented, `Unsupported action: ${action}`);
      return;
    }
    if (def.origin === 'CS') {
      this.sendCallError(
        uniqueId,
        RpcErrorCode.NotSupported,
        `${action} may not be sent by a charge point`,
      );
      return;
    }

    const parsed = def.req.safeParse(payload ?? {});
    if (!parsed.success) {
      ocppLogger.warn(
        { cp: this.chargePointId, action, issues: parsed.error.issues },
        'inbound payload failed validation',
      );
      this.sendCallError(
        uniqueId,
        RpcErrorCode.FormationViolation,
        `Invalid ${action} payload`,
        parsed.error.flatten(),
      );
      return;
    }

    try {
      const result = await this.handler(action, parsed.data, this);
      const confParsed = def.conf.safeParse(result ?? {});
      if (!confParsed.success) {
        ocppLogger.error(
          { cp: this.chargePointId, action, issues: confParsed.error.issues },
          'handler produced an invalid response',
        );
        this.sendCallError(uniqueId, RpcErrorCode.InternalError, 'Invalid response generated');
        return;
      }
      this.sendCallResult(uniqueId, result ?? {});
    } catch (err) {
      if (err instanceof OcppRpcError) {
        this.sendCallError(uniqueId, err.code, err.message, err.details);
      } else {
        ocppLogger.error({ err, cp: this.chargePointId, action }, 'handler threw');
        this.sendCallError(uniqueId, RpcErrorCode.InternalError, 'Internal error');
      }
    }
  }

  private handleCallResult(uniqueId: string, payload: unknown): void {
    const p = this.pending.get(uniqueId);
    void this.logFrame('IN', MessageType.CALLRESULT, uniqueId, p?.action, payload);
    if (!p) {
      ocppLogger.warn({ cp: this.chargePointId, uniqueId }, 'CALLRESULT for unknown uniqueId');
      return;
    }
    clearTimeout(p.timer);

    const def = getMessageDefinition(p.action);
    const parsed = def ? def.conf.safeParse(payload ?? {}) : undefined;
    const value = parsed?.success ? parsed.data : (payload ?? {});

    if (parsed && !parsed.success) {
      ocppLogger.warn(
        { cp: this.chargePointId, action: p.action, issues: parsed.error.issues },
        'CALLRESULT failed validation; passing raw payload through',
      );
    }

    void this.finishCommandLog(p.commandLogId, 'Success', value, undefined, p.startedAt);
    bus.emitEvent('command.result', this.chargePointId, {
      action: p.action,
      uniqueId,
      status: 'Success',
      response: value,
    });
    p.resolve(value);
  }

  private handleCallError(
    uniqueId: string,
    code: string,
    description: string,
    details: unknown,
  ): void {
    const p = this.pending.get(uniqueId);
    void this.logFrame('IN', MessageType.CALLERROR, uniqueId, p?.action, details, code, description);
    if (!p) {
      ocppLogger.warn({ cp: this.chargePointId, uniqueId, code }, 'CALLERROR for unknown uniqueId');
      return;
    }
    clearTimeout(p.timer);
    void this.finishCommandLog(
      p.commandLogId,
      'Failed',
      undefined,
      `${code}: ${description}`,
      p.startedAt,
    );
    bus.emitEvent('command.result', this.chargePointId, {
      action: p.action,
      uniqueId,
      status: 'Failed',
      error: `${code}: ${description}`,
    });
    p.reject(new OcppRpcError(code as never, description || code, details));
  }

  // -------------------------------------------------------------------------
  // Frame writers
  // -------------------------------------------------------------------------

  private sendCallResult(uniqueId: string, payload: unknown): void {
    if (!this.isOpen) return;
    this.socket.send(JSON.stringify([MessageType.CALLRESULT, uniqueId, payload]));
    void this.logFrame('OUT', MessageType.CALLRESULT, uniqueId, undefined, payload);
  }

  private sendCallError(
    uniqueId: string,
    code: string,
    description: string,
    details: unknown = {},
  ): void {
    if (!this.isOpen) return;
    this.socket.send(JSON.stringify([MessageType.CALLERROR, uniqueId, code, description, details]));
    void this.logFrame('OUT', MessageType.CALLERROR, uniqueId, undefined, details, code, description);
  }

  // -------------------------------------------------------------------------
  // Housekeeping
  // -------------------------------------------------------------------------

  private startPing(): void {
    if (env.OCPP_PING_INTERVAL_MS <= 0) return;
    this.pingTimer = setInterval(() => {
      if (!this.isAlive) {
        ocppLogger.warn({ cp: this.chargePointId }, 'no pong received, terminating connection');
        this.socket.terminate();
        return;
      }
      this.isAlive = false;
      try {
        this.socket.ping();
      } catch {
        /* socket already gone */
      }
    }, env.OCPP_PING_INTERVAL_MS);
  }

  private onClose(code: number, reason: string): void {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);

    const err = new Error(`Connection closed (${code}${reason ? `: ${reason}` : ''})`);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      void this.finishCommandLog(p.commandLogId, 'Failed', undefined, err.message, p.startedAt);
      p.reject(err);
    }
    this.pending.clear();
    for (const q of this.queue.splice(0)) q.reject(err);
  }

  close(code = 1000, reason = 'Central System closing connection'): void {
    this.closed = true;
    try {
      this.socket.close(code, reason);
    } catch {
      this.socket.terminate();
    }
  }

  private async logFrame(
    direction: 'IN' | 'OUT',
    messageTypeId: number,
    uniqueId: string,
    action?: string,
    payload?: unknown,
    errorCode?: string,
    errorDescription?: string,
  ): Promise<void> {
    if (!env.OCPP_LOG_MESSAGES) return;
    try {
      await OcppMessageLog.create({
        chargePointId: this.chargePointId,
        direction,
        messageTypeId,
        uniqueId,
        action,
        payload: payload ?? {},
        errorCode,
        errorDescription,
      });
    } catch (err) {
      ocppLogger.debug({ err }, 'failed to write message log');
    }
  }

  private async finishCommandLog(
    id: string | undefined,
    status: 'Success' | 'Failed' | 'TimedOut',
    response?: unknown,
    error?: string,
    startedAt?: number,
  ): Promise<void> {
    if (!id) return;
    try {
      await CommandLog.findByIdAndUpdate(id, {
        status,
        response: response ?? null,
        error,
        completedAt: new Date(),
        durationMs: startedAt ? Date.now() - startedAt : undefined,
      });
    } catch (err) {
      ocppLogger.debug({ err }, 'failed to update command log');
    }
  }
}

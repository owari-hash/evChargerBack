import { nextSequence } from '../lib/counters';
import { logger } from '../lib/logger';
import { ChargePoint } from '../models/ChargePoint';
import { Connector } from '../models/Connector';
import { Reservation } from '../models/Reservation';
import { Transaction } from '../models/Transaction';
import type { StopReason } from '../models/enums';
import type { IdTagInfo, MeterValueEntry } from '../ocpp/schemas/common';
import { bus } from '../realtime/events';
import { authorizeIdTag, canStopTransaction } from './authorization.service';
import { storeMeterValues } from './meter.service';
import { chargeSessionToWallet } from './wallet.service';

export interface StartTransactionInput {
  chargePointId: string;
  connectorId: number;
  idTag: string;
  meterStart: number;
  timestamp: Date;
  reservationId?: number;
}

export interface StartTransactionResult {
  transactionId: number;
  idTagInfo: IdTagInfo;
}

export async function startTransaction(
  input: StartTransactionInput,
): Promise<StartTransactionResult> {
  const idTagInfo = await authorizeIdTag(input.idTag, { chargePointId: input.chargePointId });

  // OCPP 1.6: a transactionId is always returned, even when authorization is
  // rejected, so the charge point can correlate a later StopTransaction.
  const transactionId = await nextSequence('transactionId');

  const cp = await ChargePoint.findById(input.chargePointId).lean();

  await Transaction.create({
    _id: transactionId,
    chargePointId: input.chargePointId,
    connectorId: input.connectorId,
    idTag: input.idTag,
    status: idTagInfo.status === 'Accepted' ? 'Active' : 'Rejected',
    meterStart: input.meterStart,
    lastMeterWh: input.meterStart,
    startTimestamp: input.timestamp,
    reservationId: input.reservationId,
    tariffPerKwh: cp?.tariffPerKwh ?? undefined,
  });

  if (idTagInfo.status === 'Accepted') {
    await Connector.updateOne(
      { chargePointId: input.chargePointId, connectorId: input.connectorId },
      { $set: { currentTransactionId: transactionId, lastMeterWh: input.meterStart } },
      { upsert: false },
    ).catch(() => undefined);

    if (input.reservationId !== undefined) {
      await Reservation.findByIdAndUpdate(input.reservationId, {
        $set: { state: 'Used', transactionId },
      }).catch(() => undefined);
    }

    bus.emitEvent('transaction.started', input.chargePointId, {
      transactionId,
      connectorId: input.connectorId,
      idTag: input.idTag,
      meterStart: input.meterStart,
      timestamp: input.timestamp,
    });
  }

  return { transactionId, idTagInfo };
}

export interface StopTransactionInput {
  chargePointId: string;
  transactionId: number;
  meterStop: number;
  timestamp: Date;
  idTag?: string;
  reason?: StopReason;
  transactionData?: MeterValueEntry[];
}

export async function stopTransaction(
  input: StopTransactionInput,
): Promise<{ idTagInfo?: IdTagInfo }> {
  const tx = await Transaction.findById(input.transactionId);

  if (!tx) {
    logger.warn(
      { cp: input.chargePointId, transactionId: input.transactionId },
      'StopTransaction for an unknown transaction',
    );
    // Still acknowledge; the charge point cannot do anything useful with an error.
    return input.idTag
      ? { idTagInfo: await authorizeIdTag(input.idTag, { skipConcurrencyCheck: true }) }
      : {};
  }

  if (input.transactionData?.length) {
    await storeMeterValues(
      input.chargePointId,
      tx.connectorId,
      tx._id,
      input.transactionData,
    ).catch((err) => logger.warn({ err }, 'failed to store transactionData'));
  }

  if (tx.status === 'Active') {
    tx.status = 'Completed';
    tx.meterStop = input.meterStop;
    tx.stopTimestamp = input.timestamp;
    tx.stopReason = input.reason ?? null;
    tx.stopIdTag = input.idTag;
    tx.energyWh = Math.max(0, input.meterStop - tx.meterStart);
    tx.lastMeterWh = input.meterStop;
    if (tx.tariffPerKwh) {
      tx.cost = Number(((tx.energyWh / 1000) * tx.tariffPerKwh).toFixed(4));
    }
    await tx.save();

    await Connector.updateOne(
      { chargePointId: tx.chargePointId, connectorId: tx.connectorId, currentTransactionId: tx._id },
      { $set: { currentTransactionId: null } },
    ).catch(() => undefined);

    bus.emitEvent('transaction.stopped', input.chargePointId, {
      transactionId: tx._id,
      connectorId: tx.connectorId,
      idTag: tx.idTag,
      meterStop: input.meterStop,
      energyWh: tx.energyWh,
      cost: tx.cost,
      reason: input.reason,
      timestamp: input.timestamp,
    });

    // Bill the prepaid wallet behind the tag. Never throws — the charge point is
    // waiting on this StopTransaction, and a billing problem is ours to fix, not
    // a reason to leave the connector stuck.
    if (tx.cost && tx.cost > 0) {
      await chargeSessionToWallet({
        transactionId: tx._id,
        idTag: tx.idTag,
        amount: tx.cost,
        chargePointId: tx.chargePointId,
        connectorId: tx.connectorId,
        energyWh: tx.energyWh ?? 0,
      });
    }
  }

  if (!input.idTag) return {};

  // A DeAuthorized / locally-stopped transaction still gets an idTagInfo back.
  const allowed = await canStopTransaction(input.idTag, tx.idTag);
  const idTagInfo = await authorizeIdTag(input.idTag, { skipConcurrencyCheck: true });
  if (!allowed && idTagInfo.status === 'Accepted') {
    return { idTagInfo: { ...idTagInfo, status: 'Invalid' } };
  }
  return { idTagInfo };
}

/** Close transactions left dangling by a charge point that rebooted mid-charge. */
export async function closeOrphanedTransactions(
  chargePointId: string,
  reason: StopReason = 'PowerLoss',
): Promise<number> {
  const open = await Transaction.find({ chargePointId, status: 'Active' });
  for (const tx of open) {
    tx.status = 'Completed';
    tx.stopTimestamp = new Date();
    tx.stopReason = reason;
    tx.meterStop = tx.lastMeterWh ?? tx.meterStart;
    tx.energyWh = Math.max(0, (tx.meterStop ?? tx.meterStart) - tx.meterStart);
    if (tx.tariffPerKwh) {
      tx.cost = Number(((tx.energyWh / 1000) * tx.tariffPerKwh).toFixed(4));
    }
    await tx.save();
    bus.emitEvent('transaction.stopped', chargePointId, {
      transactionId: tx._id,
      reason,
      orphaned: true,
    });

    // Energy the car actually took still has to be paid for, even though the
    // charge point never sent a StopTransaction for it.
    if (tx.cost && tx.cost > 0) {
      await chargeSessionToWallet({
        transactionId: tx._id,
        idTag: tx.idTag,
        amount: tx.cost,
        chargePointId: tx.chargePointId,
        connectorId: tx.connectorId,
        energyWh: tx.energyWh ?? 0,
      });
    }
  }
  if (open.length > 0) {
    await Connector.updateMany(
      { chargePointId },
      { $set: { currentTransactionId: null } },
    ).catch(() => undefined);
  }
  return open.length;
}

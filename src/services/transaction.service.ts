import type { Types } from 'mongoose';
import { nextSequence } from '../lib/counters';
import { logger } from '../lib/logger';
import { ChargePoint } from '../models/ChargePoint';
import { Connector } from '../models/Connector';
import { Reservation } from '../models/Reservation';
import { Transaction, type TransactionDoc } from '../models/Transaction';
import type { StopReason } from '../models/enums';
import type { IdTagInfo, MeterValueEntry } from '../ocpp/schemas/common';
import { store } from '../driver/store';
import { bus } from '../realtime/events';
import { IdTag } from '../models/IdTag';
import { sendSms } from '../driver/notify';
import { authorizeIdTag, canStopTransaction } from './authorization.service';
import { storeMeterValues } from './meter.service';
import { applySessionCost, feePercentForStation } from './pricing.service';
import {
  balanceOf,
  chargeSessionToWallet,
  resettleSessionWallet,
  resolveWalletOwnerForIdTag,
} from './wallet.service';

export interface StartTransactionInput {
  /** The charge point's `_id`, which is what the records reference. */
  chargePointId: Types.ObjectId;
  /** Its OCPP identifier, for the events published to subscribers. */
  cpId: string;
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
  // A station that never got our .conf resends the identical StartTransaction.
  // Answer with the transaction already opened for it: a second one would fail
  // ConcurrentTx and leave the first Active forever, locking the driver's tag.
  const replay = await Transaction.findOne({
    chargePointId: input.chargePointId,
    connectorId: input.connectorId,
    idTag: input.idTag,
    meterStart: input.meterStart,
    startTimestamp: input.timestamp,
  });
  if (replay) {
    logger.info(
      { cp: input.cpId, transactionId: replay._id },
      'StartTransaction replayed; returning the existing transaction',
    );
    const replayInfo = await authorizeIdTag(input.idTag, {
      chargePointId: input.chargePointId,
      // The replayed transaction is itself the tag's one active session.
      skipConcurrencyCheck: replay.status === 'Active',
    });
    return { transactionId: replay._id, idTagInfo: replayInfo };
  }

  // A connector runs one transaction at a time. A new start on a connector we
  // still hold a session for means that session ended without its
  // StopTransaction reaching us; close it before the tag check counts it.
  const stale = await Transaction.find({
    chargePointId: input.chargePointId,
    connectorId: input.connectorId,
    status: 'Active',
  });
  for (const old of stale) {
    logger.warn(
      { cp: input.cpId, connectorId: input.connectorId, transactionId: old._id },
      'new StartTransaction on a busy connector; closing the stale transaction',
    );
    await closeFromLastMeter(old, input.cpId, 'Other');
  }

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
    // Snapshot the price terms and the owner: a later change must not reprice
    // a running session or move its earnings to another client.
    feePercent: cp ? await feePercentForStation(cp) : undefined,
    // null = "no client", distinct from sessions recorded before this field existed.
    clientId: cp?.clientId ?? null,
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

    // The driver's name is for the console's live notifications only. Looked up
    // off the OCPP path, so StartTransaction.conf is never held up by it.
    const started = {
      transactionId,
      connectorId: input.connectorId,
      idTag: input.idTag,
      meterStart: input.meterStart,
      timestamp: input.timestamp,
    };
    void store
      .findUserByIdTag(input.idTag)
      .then((driver) => driver?.name?.trim() || undefined)
      .catch(() => undefined)
      .then((driverName) => bus.emitEvent('transaction.started', input.cpId, { ...started, driverName }));
  }

  return { transactionId, idTagInfo };
}

export interface StopTransactionInput {
  chargePointId: Types.ObjectId;
  cpId: string;
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
      { cp: input.cpId, transactionId: input.transactionId },
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
      input.cpId,
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
    applySessionCost(tx);
    await tx.save();

    await Connector.updateOne(
      { chargePointId: tx.chargePointId, connectorId: tx.connectorId, currentTransactionId: tx._id },
      { $set: { currentTransactionId: null } },
    ).catch(() => undefined);

    bus.emitEvent('transaction.stopped', input.cpId, {
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

    // Notify the driver via SMS if ownerPhone is registered
    try {
      const idTagDoc = await IdTag.findById(tx.idTag).select('ownerPhone').lean();
      if (idTagDoc?.ownerPhone) {
        const owner = await resolveWalletOwnerForIdTag(tx.idTag);
        const balance = owner ? await balanceOf(owner) : 0;
        const kwh = ((tx.energyWh ?? 0) / 1000).toFixed(2);
        const costStr = (tx.cost ?? 0).toLocaleString('mn-MN');
        const balanceStr = balance.toLocaleString('mn-MN');
        void sendSms({
          to: idTagDoc.ownerPhone,
          text: `Tany tseneglelt duuslaa. Ashiglasan:(${kwh} kw). Uldegel: ${balanceStr}. Bayrlalaa!`,
        }).catch((err) => logger.warn({ err, txId: tx._id }, 'failed to send stop SMS to driver'));
      }
    } catch (err) {
      logger.warn({ err, txId: tx._id }, 'failed to prepare stop SMS notification');
    }
  } else if (tx.status === 'Completed' && tx.closedByCsms) {
    await resettleClosedTransaction(tx._id, input);
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

/**
 * Close a session the station never sent a StopTransaction for, billing the
 * last meter reading we saw. It is marked `closedByCsms`, so if the station's
 * own StopTransaction turns up afterwards (OCPP has it queue one across a
 * reboot) the bill is corrected to the real meterStop, once.
 */
export async function closeFromLastMeter(
  tx: TransactionDoc,
  cpId: string,
  reason: StopReason,
  meterStop: number = tx.lastMeterWh ?? tx.meterStart,
): Promise<void> {
  tx.status = 'Completed';
  tx.closedByCsms = true;
  tx.stopTimestamp = new Date();
  tx.stopReason = reason;
  tx.meterStop = meterStop;
  tx.energyWh = Math.max(0, meterStop - tx.meterStart);
  applySessionCost(tx);
  await tx.save();

  await Connector.updateOne(
    { chargePointId: tx.chargePointId, connectorId: tx.connectorId, currentTransactionId: tx._id },
    { $set: { currentTransactionId: null } },
  ).catch(() => undefined);

  bus.emitEvent('transaction.stopped', cpId, {
    transactionId: tx._id,
    connectorId: tx.connectorId,
    idTag: tx.idTag,
    meterStop,
    energyWh: tx.energyWh,
    cost: tx.cost,
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

/**
 * The station's StopTransaction for a session we already closed ourselves.
 * Its meterStop is the real one, so energy, cost and the wallet charge are
 * brought in line with it — up or down. Claimed atomically, so a retried
 * StopTransaction cannot settle twice.
 */
async function resettleClosedTransaction(
  transactionId: number,
  input: StopTransactionInput,
): Promise<void> {
  const tx = await Transaction.findOneAndUpdate(
    { _id: transactionId, status: 'Completed', closedByCsms: true },
    { $set: { closedByCsms: false } },
    { new: true },
  );
  if (!tx) return;

  const energyWh = Math.max(0, input.meterStop - tx.meterStart);
  if (energyWh === tx.energyWh) return;

  const previousWh = tx.energyWh ?? 0;
  tx.meterStop = input.meterStop;
  tx.lastMeterWh = input.meterStop;
  tx.energyWh = energyWh;
  tx.stopTimestamp = input.timestamp;
  if (input.reason) tx.stopReason = input.reason;
  if (input.idTag) tx.stopIdTag = input.idTag;
  applySessionCost(tx);
  await tx.save();

  logger.info(
    { cp: input.cpId, transactionId, previousWh, energyWh, cost: tx.cost },
    'late StopTransaction re-settled a CSMS-closed transaction',
  );

  bus.emitEvent('transaction.stopped', input.cpId, {
    transactionId: tx._id,
    connectorId: tx.connectorId,
    idTag: tx.idTag,
    meterStop: input.meterStop,
    energyWh,
    cost: tx.cost,
    reason: tx.stopReason,
    timestamp: input.timestamp,
    resettled: true,
  });

  await resettleSessionWallet({
    transactionId: tx._id,
    idTag: tx.idTag,
    amount: tx.cost ?? 0,
    chargePointId: tx.chargePointId,
    connectorId: tx.connectorId,
    energyWh,
  });
}

/** Close transactions left dangling by a charge point that rebooted mid-charge. */
export async function closeOrphanedTransactions(
  chargePointId: Types.ObjectId,
  cpId: string,
  reason: StopReason = 'PowerLoss',
): Promise<number> {
  const open = await Transaction.find({ chargePointId, status: 'Active' });
  for (const tx of open) {
    await closeFromLastMeter(tx, cpId, reason);
  }
  if (open.length > 0) {
    await Connector.updateMany(
      { chargePointId },
      { $set: { currentTransactionId: null } },
    ).catch(() => undefined);
  }
  return open.length;
}

import type { Types } from 'mongoose';
import { nextSequence } from '../lib/counters';
import { logger } from '../lib/logger';
import { ChargePoint } from '../models/ChargePoint';
import { Connector } from '../models/Connector';
import { Reservation } from '../models/Reservation';
import { Transaction, type TransactionDoc } from '../models/Transaction';
import type { StopReason } from '../models/enums';
import type { IdTagInfo, MeterValueEntry } from '../ocpp/schemas/common';
import { store, DriverUser } from '../driver/store';
import { bus } from '../realtime/events';
import { IdTag } from '../models/IdTag';
import { sendSms, templates } from '../driver/notify';
import { authorizeIdTag, canStopTransaction } from './authorization.service';
import { storeMeterValues } from './meter.service';
import { applySessionCost, capCostToBalance, feePercentForStation } from './pricing.service';
import {
  balanceOf,
  chargeSessionToWallet,
  isInternalTag,
  resettleSessionWallet,
  resolveWalletOwnerForIdTag,
} from './wallet.service';
import { env } from '../config/env';
import { issueEBarimtForTransaction } from './ebarimt.service';

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

  const ebarimtRequest =
    idTagInfo.status === 'Accepted' ? await takePendingEbarimt(input.idTag) : undefined;

  let maxAllowedCost: number | undefined;
  let maxAllowedEnergyKwh: number | undefined;

  try {
    const isInternal = await isInternalTag(input.idTag);
    const owner = await resolveWalletOwnerForIdTag(input.idTag);
    if (!isInternal && owner && owner.ownerType !== 'CLIENT') {
      const balance = await balanceOf(owner);
      if (balance > 0) {
        maxAllowedCost = balance;
        const tariff = cp?.tariffPerKwh ?? 1000;
        if (tariff > 0) {
          maxAllowedEnergyKwh = Math.floor((balance / tariff) * 1000) / 1000;
        }
      }
    }
  } catch (err) {
    logger.warn({ err, idTag: input.idTag }, 'could not resolve initial wallet limit for startTransaction');
  }

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
    ebarimtRequest,
    tariffPerKwh: cp?.tariffPerKwh ?? undefined,
    tariffZones: cp?.tariffZones?.length ? cp.tariffZones : undefined,
    // Snapshot the price terms and the owner: a later change must not reprice
    // a running session or move its earnings to another client.
    feePercent: cp ? await feePercentForStation(cp) : undefined,
    // null = "no client", distinct from sessions recorded before this field existed.
    clientId: cp?.clientId ?? null,
    maxAllowedCost,
    maxAllowedEnergyKwh,
    // Inherit vehicle information from recent DataTransfer/BMS handshake (within 15 min)
    ...(cp?.lastVehicleInfo &&
    cp.lastVehicleInfo.receivedAt &&
    Date.now() - new Date(cp.lastVehicleInfo.receivedAt).getTime() < 15 * 60 * 1000
      ? {
          vehicleVin: cp.lastVehicleInfo.vin,
          vehicleModel: cp.lastVehicleInfo.model,
          vehicleSoc: cp.lastVehicleInfo.soc,
          vehicleBatteryKwh: cp.lastVehicleInfo.batteryKwh,
          vehicleData: cp.lastVehicleInfo.data,
        }
      : {}),
  });

  if (idTagInfo.status === 'Accepted') {
    await Connector.updateOne(
      { chargePointId: input.chargePointId, connectorId: input.connectorId },
      {
        $set: { currentTransactionId: transactionId, lastMeterWh: input.meterStart },
        // The previous car's battery and power are not this one's: the app and
        // site showed them as the new charge's until the station reported.
        $unset: { lastSocPercent: 1, lastPowerW: 1 },
      },
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

async function enforcePrepaidBalanceCap(tx: TransactionDoc): Promise<void> {
  if (!env.WALLET_ENABLED) return;
  try {
    const isInternal = await isInternalTag(tx.idTag);
    if (isInternal) return; // Do not cap internal sessions; preserve real energyWh, feeAmount, cost for admin reports
    const owner = await resolveWalletOwnerForIdTag(tx.idTag);
    if (owner && owner.ownerType !== 'CLIENT') {
      const cap =
        typeof tx.maxAllowedCost === 'number' && tx.maxAllowedCost > 0
          ? tx.maxAllowedCost
          : await balanceOf(owner);
      capCostToBalance(tx, cap);
    }
  } catch (err) {
    logger.warn({ err, txId: tx._id }, 'failed capping prepaid cost to wallet balance');
  }
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
    // Protect against station/simulator rewinding meterStop below already accumulated telemetry
    const finalMeterStop = Math.max(
      input.meterStop ?? 0,
      tx.lastMeterWh ?? tx.meterStart,
      tx.meterStart,
    );
    tx.meterStop = finalMeterStop;
    tx.lastMeterWh = finalMeterStop;
    tx.energyWh = Math.max(tx.energyWh ?? 0, finalMeterStop - tx.meterStart);

    // Stop timestamp must be at or after startTimestamp and valid (fallback to now)
    const validStop =
      input.timestamp &&
      !isNaN(new Date(input.timestamp).getTime()) &&
      new Date(input.timestamp) >= tx.startTimestamp;
    tx.stopTimestamp = validStop ? input.timestamp : new Date();

    tx.stopReason = input.reason ?? null;
    tx.stopIdTag = input.idTag;
    applySessionCost(tx);
    await enforcePrepaidBalanceCap(tx);
    await tx.save();

    await Connector.updateOne(
      { chargePointId: tx.chargePointId, connectorId: tx.connectorId },
      {
        $set: {
          currentTransactionId: null,
          status: 'Available',
          statusTimestamp: new Date(),
        },
      },
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

      // The driver chose personal or company when they pressed Charge.
      autoIssueEbarimt(tx);
    }

    // Notify the driver via SMS for session end
    void sendSessionStopSms(tx);
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

/** How long a choice sent with RemoteStart waits for the station to start. */
const PENDING_EBARIMT_MS = 5 * 60 * 1000;

/**
 * Claims the e-barimt choice the driver sent with their remote start, if it
 * is fresh. Cleared in the same step so a later start (an RFID card at the
 * unit, say) does not inherit it.
 */
async function takePendingEbarimt(idTag: string) {
  const tag = await IdTag.findOneAndUpdate(
    { _id: idTag, 'pendingEbarimt.type': { $exists: true } },
    { $unset: { pendingEbarimt: 1 } },
  )
    .lean()
    .catch(() => null);
  const pending = tag?.pendingEbarimt;
  if (!pending?.type || !pending.at) return undefined;
  if (Date.now() - new Date(pending.at).getTime() > PENDING_EBARIMT_MS) return undefined;
  return {
    type: pending.type,
    customerTin: pending.customerTin ?? undefined,
    customerName: pending.customerName ?? undefined,
    requestedAt: new Date(),
  };
}

/**
 * Issues the receipt the driver asked for at start, for the billed amount.
 * Runs off the OCPP path: the PosAPI can be slow, and the station is waiting
 * on StopTransaction.conf. A failure leaves `ebarimt.status = FAILED` and the
 * driver can still request it by hand from the session screen.
 */
function autoIssueEbarimt(tx: TransactionDoc): void {
  const request = tx.ebarimtRequest;
  if (!request?.type || !(tx.cost && tx.cost > 0)) return;
  void issueEBarimtForTransaction(tx._id, {
    type: request.type,
    customerTin: request.type === 'B2B_RECEIPT' ? request.customerTin ?? undefined : undefined,
  }).catch((err: unknown) =>
    logger.warn(
      { txId: tx._id, err: (err as Error).message },
      'auto e-barimt after session end failed',
    ),
  );
}

async function sendSessionStopSms(tx: TransactionDoc): Promise<void> {
  try {
    const owner = await resolveWalletOwnerForIdTag(tx.idTag);
    let phone: string | undefined | null;

    // 1. Check IdTag ownerPhone
    const idTagDoc = await IdTag.findById(tx.idTag).select('ownerPhone').lean();
    if (idTagDoc?.ownerPhone) {
      phone = idTagDoc.ownerPhone;
    }

    // 2. If not on IdTag, check DriverUser by owner or by idTag
    if (!phone && owner?.ownerType === 'USER') {
      const driver = await DriverUser.findById(owner.ownerId).select('phone').lean();
      phone = driver?.phone;
    }
    if (!phone) {
      const driverByTag = await DriverUser.findOne({ idTag: tx.idTag }).select('phone').lean();
      phone = driverByTag?.phone;
    }

    if (phone) {
      const balance = owner ? await balanceOf(owner) : 0;
      const kwh = ((tx.energyWh ?? 0) / 1000).toFixed(2);
      const usedAmountStr = (tx.cost ?? 0).toLocaleString('mn-MN');
      const balanceStr = balance.toLocaleString('mn-MN');
      await sendSms({
        to: phone,
        text: templates.sessionStopSms(kwh, usedAmountStr, balanceStr),
      });
    }
  } catch (err) {
    logger.warn({ err, txId: tx._id }, 'failed to send stop SMS to driver');
  }
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
  await enforcePrepaidBalanceCap(tx);
  await tx.save();

  await Connector.updateOne(
    { chargePointId: tx.chargePointId, connectorId: tx.connectorId },
    {
      $set: {
        currentTransactionId: null,
        status: 'Available',
        statusTimestamp: new Date(),
      },
    },
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

    autoIssueEbarimt(tx);

    void sendSessionStopSms(tx);
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

  const finalMeterStop = Math.max(
    input.meterStop ?? 0,
    tx.lastMeterWh ?? tx.meterStart,
    tx.meterStart,
  );
  const energyWh = Math.max(tx.energyWh ?? 0, finalMeterStop - tx.meterStart);
  if (energyWh === tx.energyWh && tx.meterStop === finalMeterStop) return;

  const previousWh = tx.energyWh ?? 0;
  tx.meterStop = finalMeterStop;
  tx.lastMeterWh = finalMeterStop;
  tx.energyWh = energyWh;
  const validStop =
    input.timestamp &&
    !isNaN(new Date(input.timestamp).getTime()) &&
    new Date(input.timestamp) >= tx.startTimestamp;
  tx.stopTimestamp = validStop ? input.timestamp : (tx.stopTimestamp || new Date());
  if (input.reason) tx.stopReason = input.reason;
  if (input.idTag) tx.stopIdTag = input.idTag;
  applySessionCost(tx);
  await enforcePrepaidBalanceCap(tx);
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

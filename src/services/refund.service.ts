import { cpIdFor } from '../lib/chargePointRef';
import { conflict, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { Transaction, type TransactionDoc } from '../models/Transaction';
import { bus } from '../realtime/events';
import { returnEBarimtForTransaction } from './ebarimt.service';
import { credit, netChargeForTransaction } from './wallet.service';

/**
 * Буцаалт: return a completed session's charge to the wallet it was paid from.
 *
 * Order matters. The e-barimt receipt is returned at the PosAPI first — if that
 * fails nothing else happens, so no money is refunded against a receipt that is
 * still valid. Then the net charge is credited (idempotent, so a retry after a
 * crash cannot pay twice) and the transaction becomes `Refunded`.
 */
export async function refundTransaction(
  transactionId: number,
  opts: { reason: string; refundedBy: string; accountNumber?: string },
): Promise<TransactionDoc> {
  const tx = await Transaction.findById(transactionId);
  if (!tx) throw notFound('Transaction not found');
  if (tx.status === 'Refunded') throw conflict('Энэ цэнэглэлтэд буцаалт аль хэдийн хийгдсэн');
  if (tx.status !== 'Completed') {
    throw conflict('Зөвхөн дууссан цэнэглэлтэд буцаалт хийнэ');
  }

  const { charged, owner } = await netChargeForTransaction(transactionId);
  if (!owner || charged <= 0) {
    throw conflict('Энэ цэнэглэлтээс хэтэвчнээс мөнгө хасагдаагүй тул буцаах дүн алга');
  }

  // Claim the refund so two operators clicking at once cannot both run it.
  const claimed = await Transaction.findOneAndUpdate(
    { _id: transactionId, status: 'Completed', 'refund.state': { $ne: 'PENDING' } },
    { $set: { 'refund.state': 'PENDING' } },
    { new: true },
  );
  if (!claimed) throw conflict('Энэ цэнэглэлтийн буцаалт хийгдэж байна');

  try {
    const { returned } = await returnEBarimtForTransaction(claimed);

    const movement = await credit(owner, charged, 'REFUND', {
      description: `Буцаалт · Цэнэглэлт #${transactionId}${opts.accountNumber ? ` · Данс: ${opts.accountNumber}` : ''}${opts.reason ? ` · ${opts.reason}` : ''}`,
      idempotencyKey: `refund:transaction:${transactionId}`,
      transactionId,
      chargePointId: claimed.chargePointId,
      connectorId: claimed.connectorId,
      idTag: claimed.idTag,
      accountNumber: opts.accountNumber,
      createdBy: opts.refundedBy,
    });

    const done = await Transaction.findByIdAndUpdate(
      transactionId,
      {
        $set: {
          status: 'Refunded',
          refund: {
            state: 'DONE',
            amount: charged,
            reason: opts.reason,
            accountNumber: opts.accountNumber,
            refundedBy: opts.refundedBy,
            refundedAt: new Date(),
            walletEntryId: movement.entryId ?? undefined,
            ebarimtReturned: returned,
          },
        },
      },
      { new: true },
    );

    logger.info(
      { transactionId, amount: charged, ebarimtReturned: returned, by: opts.refundedBy },
      'transaction refunded',
    );
    bus.emitEvent('transaction.refunded', await cpIdFor(claimed.chargePointId), {
      transactionId,
      amount: charged,
      idTag: claimed.idTag,
      ebarimtReturned: returned,
      refundedBy: opts.refundedBy,
    });
    return done!;
  } catch (err) {
    // Release the claim; a retry skips whatever already succeeded.
    await Transaction.updateOne(
      { _id: transactionId, 'refund.state': 'PENDING' },
      { $unset: { 'refund.state': 1 } },
    ).catch(() => undefined);
    throw err;
  }
}

/**
 * Wallet reconciliation for driver statements.
 *
 * Ledger amounts are stored unsigned; the direction of each movement comes from the
 * change in `balanceAfter`, so an ADJUSTMENT in either direction is handled. A row whose
 * balance change does not match its amount (for example a debit clamped at zero) is
 * flagged as inconsistent.
 */

export const r2 = (n: number) => Math.round(n * 100) / 100;

export interface LedgerEntryInput {
  _id: unknown;
  createdAt?: Date | null;
  type: string;
  amount: number;
  balanceAfter?: number | null;
  description?: string | null;
  transactionId?: number | null;
  paymentId?: string | null;
  createdBy?: string | null;
}

export interface LedgerRow {
  id: string;
  at: Date | null;
  type: string;
  amount: number;
  delta: number;
  balanceAfter: number;
  description: string;
  transactionId: number | null;
  paymentId: string | null;
  createdBy: string;
  consistent: boolean;
}

export interface WalletReconciliation {
  openingBalance: number;
  topups: number;
  bonuses: number;
  refunds: number;
  adjustmentsNet: number;
  charges: number;
  closingBalance: number;
  expectedClosing: number;
  ledgerMismatches: number;
  balanced: boolean;
}

/** `entries` must be one owner's entries in chronological order. */
export function reconcileLedger(
  entries: LedgerEntryInput[],
  openingBalance: number,
): { rows: LedgerRow[]; summary: WalletReconciliation } {
  let prev = r2(openingBalance);
  let mismatches = 0;
  const rows = entries.map((e) => {
    const balanceAfter = r2(e.balanceAfter ?? 0);
    const delta = r2(balanceAfter - prev);
    const sign = e.type === 'CHARGE' ? -1 : e.type === 'ADJUSTMENT' ? Math.sign(delta) || 1 : 1;
    const consistent = Math.abs(delta - sign * e.amount) < 0.01;
    if (!consistent) mismatches += 1;
    prev = balanceAfter;
    return {
      id: String(e._id),
      at: e.createdAt ?? null,
      type: e.type,
      amount: r2(e.amount),
      delta,
      balanceAfter,
      description: e.description ?? '',
      transactionId: e.transactionId ?? null,
      paymentId: e.paymentId ?? null,
      createdBy: e.createdBy ?? '',
      consistent,
    };
  });

  const sumType = (type: string) => r2(entries.filter((e) => e.type === type).reduce((a, e) => a + e.amount, 0));
  const topups = sumType('TOPUP');
  const bonuses = sumType('BONUS');
  const refunds = sumType('REFUND');
  const charges = sumType('CHARGE');
  const adjustmentsNet = r2(rows.filter((x) => x.type === 'ADJUSTMENT').reduce((a, x) => a + x.delta, 0));
  const closingBalance = rows.length ? rows[rows.length - 1].balanceAfter : r2(openingBalance);
  const expectedClosing = r2(openingBalance + topups + bonuses + refunds + adjustmentsNet - charges);

  return {
    rows,
    summary: {
      openingBalance: r2(openingBalance),
      topups,
      bonuses,
      refunds,
      adjustmentsNet,
      charges,
      closingBalance,
      expectedClosing,
      ledgerMismatches: mismatches,
      balanced: mismatches === 0 && Math.abs(expectedClosing - closingBalance) < 0.01,
    },
  };
}

/**
 * Wallet reconciliation for driver statements.
 *
 * Ledger amounts are signed: credits (TOPUP, REFUND, BONUS, credit ADJUSTMENT) are positive,
 * debits (CHARGE, debit ADJUSTMENT) are negative — see `writeEntry` in wallet.service. Each
 * row's amount must equal the change in `balanceAfter` from the previous row; a row where it
 * does not is flagged as inconsistent.
 */

/** Signed movement of an entry. Tolerates a CHARGE stored unsigned. */
export function signedAmount(e: { type: string; amount: number }): number {
  return e.type === 'CHARGE' && e.amount > 0 ? -e.amount : e.amount;
}

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
    const movement = r2(signedAmount(e));
    const consistent = Math.abs(balanceAfter - prev - movement) < 0.01;
    if (!consistent) mismatches += 1;
    prev = balanceAfter;
    return {
      id: String(e._id),
      at: e.createdAt ?? null,
      type: e.type,
      amount: Math.abs(movement),
      // The movement as recorded (+ in, − out), not the balance difference, so a broken
      // row does not hide itself.
      delta: movement,
      balanceAfter,
      description: e.description ?? '',
      transactionId: e.transactionId ?? null,
      paymentId: e.paymentId ?? null,
      createdBy: e.createdBy ?? '',
      consistent,
    };
  });

  const net = (type: string) => r2(rows.filter((x) => x.type === type).reduce((a, x) => a + x.delta, 0));
  const topups = net('TOPUP');
  const bonuses = net('BONUS');
  const refunds = net('REFUND');
  const charges = -net('CHARGE'); // shown as a positive "spent" figure
  const adjustmentsNet = net('ADJUSTMENT');
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

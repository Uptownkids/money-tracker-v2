import type { DateOnly } from "../dates/dateOnly.js";
import type { MinorUnits } from "../money/money.js";
import type { FxDetail } from "../money/fx.js";

export type TransactionType = "Income" | "Expense" | "Transfer" | "Refund";
// Scheduled: generated, not yet paid. Does NOT affect balances; counts only
// in committed. Pending: paid but not yet cleared; DOES affect balances.
// Cleared: settled; affects balances.
export type TransactionStatus = "Scheduled" | "Pending" | "Cleared";

export interface Transaction {
  id: string;
  type: TransactionType;
  amount: MinorUnits; // positive; direction comes from type + account
  currency: string;
  date: DateOnly; // calendar date, no time zone
  accountId: string; // primary account
  categoryId: string | null; // null for Transfers
  payee: string;
  status: TransactionStatus;
  notes: string;
  tags: string[];

  // Foreign currency (optional). Attached when the transaction's currency
  // differs from the account's currency. baseAmount is the amount in the
  // ACCOUNT's currency, frozen at entry — authoritative for that account's
  // totals, never recalculated. See the currency semantics note in
  // money/fx.ts before converting it further.
  fx?: FxDetail;

  // Transfer only: paying a credit card from checking is a Transfer,
  // never an Expense. `accountId` is the source account;
  // `transferToAccountId` is the destination. A goal self-transfer
  // (no linked savings account) sets both to the same spendable account.
  transferToAccountId?: string;

  // Refund only: reduces the linked expense category's spending.
  // A refund is not income.
  refundOfTransactionId?: string;

  // Provenance (optional)
  recurringRuleId?: string; // rule that generated this occurrence
  // The rule occurrence this row represents, independent of the editable
  // payment `date`. Duplicate protection keys on
  // (recurringRuleId, occurrenceDate), never on `date`, so editing a
  // payment date cannot cause regeneration.
  occurrenceDate?: DateOnly;
  goalId?: string; // goal contribution this relates to
  splitId?: string; // IOU this transaction settles or creates

  createdAt: string;
  updatedAt: string;
}

/** True for a goal self-transfer: balance-neutral allocation record. */
export function isSelfTransfer(t: Transaction): boolean {
  return (
    t.type === "Transfer" &&
    t.transferToAccountId !== undefined &&
    t.accountId === t.transferToAccountId
  );
}

/**
 * Tag marking a balance-correction inflow: real money movement, never
 * earned income. A correction is not an IOU settlement, so faking a
 * splitId for it is not acceptable — the tag is the honest mechanism.
 */
export const BALANCE_CORRECTION_TAG = "balance-correction";

/**
 * True when the row counts as earned income in income totals.
 * An Income row carrying a splitId is an IOU-settlement inflow: money in
 * (it raises the account balance), but NOT income — any "count on it"
 * amount was already added to available, so counting it would double
 * count. A balance-correction inflow is likewise money movement, not
 * earnings. Use this helper, never a bare `type === "Income"` check, at
 * any site with earned-income semantics.
 */
export function countsAsIncome(t: Transaction): boolean {
  return (
    t.type === "Income" &&
    t.splitId == null &&
    !(t.tags ?? []).includes(BALANCE_CORRECTION_TAG)
  );
}

/** True when the row affects account balances (Pending or Cleared). */
export function affectsBalance(t: Transaction): boolean {
  return t.status === "Pending" || t.status === "Cleared";
}

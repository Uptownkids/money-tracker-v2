/**
 * IOU (Split) helpers. IOUs are tracked on Split entities: someone owes
 * Malike ("TheyOweMe") or Malike owes someone ("IOweThem"). Only money owed
 * TO Malike can ever add to safe-to-spend; obligations stay out.
 */
import type { DateOnly } from "../dates/dateOnly.js";
import { sumMinor, type MinorUnits } from "../money/money.js";
import type { Split } from "../entities/split.js";
import type { Transaction } from "../entities/transaction.js";

/**
 * An IOU counts toward safe-to-spend only when: someone owes Malike
 * (never the other way around), it is flagged "count on it", it is not
 * settled, it has an expected-by date inside the projection window, and it
 * is in the base currency. This mirrors the dashboard countedIous filter.
 */
export function countsTowardAvailable(
  split: Split,
  windowEnd: DateOnly,
  baseCurrency: string,
): boolean {
  return (
    split.direction === "TheyOweMe" &&
    split.countOnIt &&
    !split.settled &&
    split.expectedBy !== undefined &&
    split.expectedBy <= windowEnd &&
    split.currency === baseCurrency
  );
}

/** Integer sum (minor units) of all IOUs that count toward safe-to-spend. */
export function countedIouTotal(
  splits: readonly Split[],
  windowEnd: DateOnly,
  baseCurrency: string,
): MinorUnits {
  return sumMinor(
    splits
      .filter((s) => countsTowardAvailable(s, windowEnd, baseCurrency))
      .map((s) => s.amount),
  );
}

/**
 * Mark an IOU settled. Returns a NEW Split; never mutates the input.
 * Creates no transaction: the repayment must not count as income, since any
 * counted amount was already added to available via "count on it".
 */
export function settleIou(split: Split, nowIso: string): Split {
  return { ...split, settled: true, settledAt: nowIso };
}

export interface SettlementBuildInput {
  split: Split;
  /** Account the money lands in (TheyOweMe) or leaves from (IOweThem). */
  accountId: string;
  /** Calendar date of the settlement. */
  date: DateOnly;
  nowIso: string;
  /**
   * The expense row the IOU links to, when split.linkedTransactionId is
   * set. Supplies the refund's category and the refundOfTransactionId
   * link. When the linked row is missing (deleted), a linked TheyOweMe
   * settles as a plain inflow instead of a refund.
   */
  linkedExpense?: Transaction;
}

/**
 * Build the ledger movement settling an IOU records — pure, no
 * persistence. The caller persists the returned row and marks the split
 * settled via settleIou. "Settle without recording" skips this entirely.
 *
 * - TheyOweMe + linked expense: a Refund of that expense (money back in,
 *   never income), carrying refundOfTransactionId and splitId.
 * - TheyOweMe standalone (or linked expense gone): an Income inflow
 *   carrying splitId. countsAsIncome() excludes it from every income
 *   total; any "count on it" amount was already added to available.
 * - IOweThem: an Expense outflow carrying splitId.
 *
 * All amounts are integer minor units; the row is Cleared on `date`.
 * Amount/category/fx validation is the caller's job (the settle sheet
 * only offers same-currency accounts).
 */
export function buildSettlementTransaction(
  input: SettlementBuildInput,
): Transaction {
  const { split, accountId, date, nowIso, linkedExpense } = input;
  const base = {
    id: crypto.randomUUID(),
    amount: split.amount,
    currency: split.currency,
    date,
    accountId,
    status: "Cleared" as const,
    notes: "",
    tags: [] as string[],
    splitId: split.id,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  if (split.direction === "TheyOweMe") {
    if (split.linkedTransactionId !== "" && linkedExpense) {
      return {
        ...base,
        type: "Refund",
        categoryId: linkedExpense.categoryId,
        payee: split.person,
        notes: `IOU repaid by ${split.person}`,
        refundOfTransactionId: linkedExpense.id,
      };
    }
    return {
      ...base,
      type: "Income",
      categoryId: null, // not earnings: kept out of category income rollups
      payee: split.person,
      notes: `IOU repaid by ${split.person}`,
    };
  }
  return {
    ...base,
    type: "Expense",
    categoryId: null, // categorized later in the log if Malike wants
    payee: split.person,
    notes: `IOU repaid to ${split.person}`,
  };
}

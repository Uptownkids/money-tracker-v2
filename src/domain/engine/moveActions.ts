/**
 * One-tap actions behind Today's Moves. Pure functions: they take the
 * current rows and return the settled/created rows; the caller persists
 * them via the repositories. Integer minor units only, always.
 *
 * Bill moves (`overdue-bill`, `bill-due-soon`) carry ids of the form
 * `move:t:<txId>` (a concrete Scheduled row) or
 * `move:p:<ruleId>:<occurrenceDate>` (a rule occurrence — the row may
 * not be generated yet for future due-soon bills).
 */
import type { DateOnly } from "../dates/dateOnly.js";
import type { MinorUnits } from "../money/money.js";
import type { RecurringRule } from "../entities/recurringRule.js";
import type { Transaction } from "../entities/transaction.js";
import type { TodaysMove } from "./todaysMoves.js";

export type BillMoveRef =
  | { kind: "tx"; txId: string }
  | { kind: "occurrence"; ruleId: string; occurrenceDate: DateOnly };

/**
 * Parse a bill move's id into a transaction or occurrence reference.
 * Returns null for non-bill moves. The occurrence date is always the
 * trailing `YYYY-MM-DD`, so rule ids containing colons still parse.
 */
export function billMoveRef(move: TodaysMove): BillMoveRef | null {
  if (move.kind !== "overdue-bill" && move.kind !== "bill-due-soon") return null;
  const body = move.id.startsWith("move:") ? move.id.slice("move:".length) : move.id;
  if (body.startsWith("t:")) {
    const txId = body.slice("t:".length);
    return txId === "" ? null : { kind: "tx", txId };
  }
  if (body.startsWith("p:")) {
    const rest = body.slice("p:".length);
    if (rest.length < 12) return null; // ruleId + ":" + YYYY-MM-DD
    const occurrenceDate = rest.slice(-10) as DateOnly;
    const ruleId = rest.slice(0, -11);
    if (ruleId === "" || !/^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate)) return null;
    return { kind: "occurrence", ruleId, occurrenceDate };
  }
  return null;
}

export interface BillMoveSettlement {
  /**
   * The Scheduled row settled in place (status -> Cleared, date ->
   * today). Type is never touched: debt-payment rows stay Transfers.
   */
  settled: Transaction | null;
  /**
   * A new Cleared row, when the bill had no Scheduled row yet (a future
   * due-soon occurrence the catch-up hasn't generated). It carries the
   * rule's (ruleId, occurrenceDate) identity so the projection merge
   * drops the occurrence exactly once.
   */
  created: Transaction | null;
}

/**
 * "Mark paid" for a bill move. Settles the open Scheduled row in place
 * when one exists; otherwise (projection-only future occurrence) records
 * a new Cleared row for the occurrence. Never rewrites a row's type.
 */
export function settleBillMove(
  transactions: readonly Transaction[],
  rules: readonly RecurringRule[],
  move: TodaysMove,
  today: DateOnly,
  nowIso: string,
): BillMoveSettlement {
  const ref = billMoveRef(move);
  if (!ref) return { settled: null, created: null };

  const open =
    ref.kind === "tx"
      ? transactions.find((t) => t.id === ref.txId && t.status === "Scheduled")
      : transactions.find(
          (t) =>
            t.status === "Scheduled" &&
            t.recurringRuleId === ref.ruleId &&
            t.occurrenceDate === ref.occurrenceDate,
        );
  if (open) {
    // A debt Transfer can never be settled from the account it pays to.
    if (
      open.transferToAccountId !== undefined &&
      open.transferToAccountId !== "" &&
      open.accountId === open.transferToAccountId
    ) {
      throw new Error("Pick a different account than the one being paid.");
    }
    return {
      settled: {
        ...open,
        // The row keeps its amount and its type; only the settlement
        // fields move. Debt-payment rows are Transfers and stay that way.
        status: "Cleared",
        date: today,
        updatedAt: nowIso,
      },
      created: null,
    };
  }

  if (ref.kind === "occurrence") {
    // A row already exists for this occurrence but is not open (it was
    // cleared or is pending): nothing to do — creating another row would
    // duplicate it.
    const anyRow = transactions.some(
      (t) => t.recurringRuleId === ref.ruleId && t.occurrenceDate === ref.occurrenceDate,
    );
    if (anyRow) return { settled: null, created: null };
    const rule = rules.find((r) => r.id === ref.ruleId);
    if (rule) {
      const isDebtPayment =
        rule.payToAccountId !== undefined && rule.payToAccountId !== "";
      if (isDebtPayment && rule.accountId === rule.payToAccountId) {
        throw new Error("Pick a different account than the one being paid.");
      }
      const amount: MinorUnits = move.amount ?? rule.amount;
      const created: Transaction = {
        id: crypto.randomUUID(),
        type: isDebtPayment ? "Transfer" : "Expense",
        amount,
        currency: rule.currency,
        date: today,
        accountId: rule.accountId,
        categoryId: isDebtPayment ? null : rule.categoryId,
        payee: rule.name,
        status: "Cleared",
        notes: "",
        tags: [],
        recurringRuleId: rule.id,
        occurrenceDate: ref.occurrenceDate,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      if (isDebtPayment) created.transferToAccountId = rule.payToAccountId;
      return { settled: null, created };
    }
  }
  return { settled: null, created: null };
}

export interface StaleCleared {
  /** The Pending row flipped to Cleared, or null when not found. */
  cleared: Transaction | null;
}

/** "Mark cleared" for a stale-pending move: Pending -> Cleared. */
export function markStaleCleared(
  transactions: readonly Transaction[],
  relatedId: string,
  nowIso: string,
): StaleCleared {
  const pending = transactions.find(
    (t) => t.id === relatedId && t.status === "Pending",
  );
  if (!pending) return { cleared: null };
  return { cleared: { ...pending, status: "Cleared", updatedAt: nowIso } };
}

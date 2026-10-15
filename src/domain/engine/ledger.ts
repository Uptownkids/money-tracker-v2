/**
 * Running balances per transaction: walks transactions in chronological
 * order and records each account's balance AFTER every processed row.
 *
 * Semantics mirror balances.ts: the same primaryDelta / destinationDelta
 * logic, fx.baseAmount is denominated in the ACCOUNT's currency, only
 * Cleared and Pending rows affect balances (Scheduled rows are skipped),
 * transfers debit the source and credit the destination, self-transfers
 * net zero, and rows whose accountId is unknown are skipped.
 */
import type { Account } from "../entities/account.js";
import type { DateOnly } from "../dates/dateOnly.js";
import { compareDateOnly, dayOfMonth } from "../dates/dateOnly.js";
import type { MinorUnits } from "../money/money.js";
import { addMinor } from "../money/money.js";
import { destinationDelta, primaryDelta } from "./balances.js";
import type { RecurringOverride, RecurringRule } from "../entities/recurringRule.js";
import { overrideId } from "../entities/recurringRule.js";
import type { Transaction } from "../entities/transaction.js";
import { affectsBalance } from "../entities/transaction.js";

/**
 * Map of tx.id -> balance of tx.accountId AFTER this transaction, in the
 * account's currency. Transactions are applied in chronological order
 * (date ascending, then createdAt ascending). Scheduled rows and rows
 * with an unknown accountId produce no entry. Self-transfers record an
 * entry (balance unchanged).
 */
export function computeRunningBalances(
  accounts: readonly Account[],
  transactions: readonly Transaction[],
): Record<string, MinorUnits> {
  const running: Record<string, MinorUnits> = {};
  for (const a of accounts) running[a.id] = a.startingBalance;

  const ordered = [...transactions].sort((x, y) => {
    if (x.date !== y.date) return x.date < y.date ? -1 : 1;
    if (x.createdAt !== y.createdAt) return x.createdAt < y.createdAt ? -1 : 1;
    return 0;
  });

  const out: Record<string, MinorUnits> = {};
  for (const t of ordered) {
    if (!affectsBalance(t)) continue; // Scheduled excluded
    if (running[t.accountId] === undefined) continue; // unknown account: ignore
    running[t.accountId] = addMinor(running[t.accountId] as MinorUnits, primaryDelta(t));
    out[t.id] = running[t.accountId] as MinorUnits;
    if (t.type === "Transfer" && t.transferToAccountId && running[t.transferToAccountId] !== undefined) {
      running[t.transferToAccountId] = addMinor(
        running[t.transferToAccountId] as MinorUnits,
        destinationDelta(t),
      );
    }
  }
  return out;
}

/**
 * Mark an occurrence as skipped. Returns a NEW rule object (never mutates
 * the input); the date is appended to skippedDates unless already present.
 */
export function addSkippedDate(rule: RecurringRule, date: DateOnly): RecurringRule {
  if (rule.skippedDates.includes(date)) return { ...rule };
  return { ...rule, skippedDates: [...rule.skippedDates, date] };
}

/**
 * Un-skip an occurrence. Returns a NEW rule object (never mutates the
 * input); a date that is not skipped is a no-op.
 */
export function removeSkippedDate(rule: RecurringRule, date: DateOnly): RecurringRule {
  if (!rule.skippedDates.includes(date)) return { ...rule };
  return { ...rule, skippedDates: rule.skippedDates.filter((d) => d !== date) };
}

/**
 * Re-key a single-occurrence override when its occurrence moves ("future"
 * + date change). A prior "this occurrence only" edit (e.g. amount) stays
 * attached to the moved occurrence instead of being orphaned at the old
 * date. The carried `date` field is dropped: the move's new date
 * supersedes it. amount / accountId / categoryId / createdAt are kept
 * as-is. Returns null when no override exists for the old occurrence.
 * The input overrides are never mutated.
 */
export function rekeyOverrideForMove(
  overrides: readonly RecurringOverride[],
  ruleId: string,
  oldOccurrenceDate: DateOnly,
  newOccurrenceDate: DateOnly,
): { deleteId: string; override: RecurringOverride } | null {
  const oldId = overrideId(ruleId, oldOccurrenceDate);
  const existing = overrides.find((o) => o.id === oldId);
  if (!existing) return null;
  const override: RecurringOverride = { ...existing };
  override.id = overrideId(ruleId, newOccurrenceDate);
  override.occurrenceDate = newOccurrenceDate;
  delete override.date; // the move's new date supersedes any carried date
  return { deleteId: oldId, override };
}

export type BillEditScope = "occurrence" | "future";

export interface BillEditChanges {
  amount?: MinorUnits;
  date?: DateOnly;
  accountId?: string;
  categoryId?: string;
}

export interface BillEditResult {
  override?: RecurringOverride;
  rule?: RecurringRule;
}

/**
 * Single source of truth for bill edits from the Today / Bills UI.
 *
 * - "occurrence": the change applies to one occurrence only. Returns an
 *   override carrying ONLY the fields present in `changes`; the rule is
 *   untouched and no rule is returned.
 * - "future": the change applies going forward. Returns an updated rule
 *   copy (amount / accountId / categoryId applied only when present in
 *   `changes`, updatedAt set to nowIso, createdAt preserved). When
 *   `changes.date` is set the rule's schedule itself moves forward —
 *   monthly/weekly/biweekly/custom/annual shift nextDueDate, semi-monthly
 *   swaps the moved day in daysOfMonth — and lastGeneratedThrough is
 *   raised to at least the new date so the moved occurrence is never
 *   regenerated. No override is returned in this case: the caller updates
 *   the current row's `date` AND `occurrenceDate` directly, so projection
 *   and row share the (ruleId, occurrenceDate) dedupe key and committed
 *   counts the bill exactly once.
 *
 * Keys are never created with undefined values, and the input rule is
 * never mutated.
 */
export function applyBillEdit(
  rule: RecurringRule,
  occurrenceDate: DateOnly,
  changes: BillEditChanges,
  nowIso: string,
  scope: BillEditScope,
): BillEditResult {
  if (scope === "occurrence") {
    const override: RecurringOverride = {
      id: overrideId(rule.id, occurrenceDate),
      ruleId: rule.id,
      occurrenceDate,
      createdAt: nowIso,
    };
    if (changes.amount !== undefined) override.amount = changes.amount;
    if (changes.date !== undefined) override.date = changes.date;
    if (changes.accountId !== undefined) override.accountId = changes.accountId;
    if (changes.categoryId !== undefined) override.categoryId = changes.categoryId;
    return { override };
  }

  const updated: RecurringRule = { ...rule, updatedAt: nowIso };
  if (changes.amount !== undefined) updated.amount = changes.amount;
  if (changes.accountId !== undefined) updated.accountId = changes.accountId;
  if (changes.categoryId !== undefined) updated.categoryId = changes.categoryId;

  if (changes.date !== undefined) {
    // Move the schedule itself forward; the caller updates the current
    // row's date and occurrenceDate, so the old canonical occurrence
    // disappears and the moved occurrence is the row.
    if (rule.frequency === "semi-monthly") {
      if (updated.daysOfMonth !== undefined) {
        const oldDay = dayOfMonth(occurrenceDate);
        const newDay = dayOfMonth(changes.date);
        updated.daysOfMonth = [...new Set(updated.daysOfMonth.map((d) => (d === oldDay ? newDay : d)))].sort(
          (a, b) => a - b,
        );
      }
    } else {
      updated.nextDueDate = changes.date;
    }
    // Raise the watermark to at least the new date so generation never
    // re-emits the moved occurrence. Missing watermark = -infinity.
    updated.lastGeneratedThrough =
      rule.lastGeneratedThrough !== undefined &&
      compareDateOnly(rule.lastGeneratedThrough, changes.date) > 0
        ? rule.lastGeneratedThrough
        : changes.date;
    return { rule: updated };
  }

  return { rule: updated };
}

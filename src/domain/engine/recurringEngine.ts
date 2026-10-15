/**
 * Recurring engine: occurrence enumeration and catch-up generation.
 *
 * Occurrence identity is the canonical (ruleId, occurrenceDate) pair, where
 * occurrenceDate is the pre-shift calendar date. The editable payment `date`
 * never participates in duplicate protection, so moving a payment's date
 * cannot cause regeneration.
 */
import {
  DateOnly,
  addDays,
  addMonthsClamped,
  addYearsClamped,
  clampDayOfMonth,
  compareDateOnly,
  dayOfMonth,
  diffDays,
  monthOf,
  shiftWeekend,
  yearOf,
} from "../dates/dateOnly.js";
import type {
  RecurringOverride,
  RecurringRule,
} from "../entities/recurringRule.js";
import type { Transaction, TransactionStatus } from "../entities/transaction.js";
import type { MinorUnits } from "../money/money.js";
import { sumMinor } from "../money/money.js";

export interface GeneratedOccurrence {
  ruleId: string;
  /** Canonical occurrence date (pre-shift, pre-override). Identity key. */
  occurrenceDate: DateOnly;
  /** Payment date after weekend shift / override. */
  date: DateOnly;
  amount: number;
}

function canonicalDates(rule: RecurringRule, from: DateOnly, to: DateOnly): DateOnly[] {
  const out: DateOnly[] = [];
  const push = (d: DateOnly) => {
    if (compareDateOnly(d, from) >= 0 && compareDateOnly(d, to) <= 0) out.push(d);
  };
  switch (rule.frequency) {
    case "weekly":
    case "biweekly":
    case "custom": {
      const step =
        rule.frequency === "weekly" ? 7 : rule.frequency === "biweekly" ? 14 : (rule.customIntervalDays ?? 0);
      if (step <= 0) throw new RangeError(`recurringEngine: custom frequency needs customIntervalDays > 0`);
      const anchor = rule.nextDueDate;
      const kMin = Math.ceil(diffDays(anchor, from) / step);
      const kMax = Math.floor(diffDays(anchor, to) / step);
      for (let k = kMin; k <= kMax; k++) push(addDays(anchor, k * step));
      break;
    }
    case "monthly": {
      const dom = dayOfMonth(rule.nextDueDate);
      let y = yearOf(from);
      let m = monthOf(from);
      for (;;) {
        push(clampDayOfMonth(y, m, dom));
        if (y === yearOf(to) && m === monthOf(to)) break;
        m += 1;
        if (m > 12) {
          m = 1;
          y += 1;
        }
        if (y > yearOf(to) + 1) break;
      }
      break;
    }
    case "semi-monthly": {
      const days = [...new Set(rule.daysOfMonth ?? [1, 15])].sort((a, b) => a - b);
      let y = yearOf(from);
      let m = monthOf(from);
      for (;;) {
        for (const day of days) push(clampDayOfMonth(y, m, day));
        if (y === yearOf(to) && m === monthOf(to)) break;
        m += 1;
        if (m > 12) {
          m = 1;
          y += 1;
        }
        if (y > yearOf(to) + 1) break;
      }
      break;
    }
    case "annual": {
      // find first occurrence >= from by stepping from the anchor
      let d = rule.nextDueDate;
      while (compareDateOnly(d, from) < 0) d = addYearsClamped(d, 1);
      // also handle occurrences before the anchor when from < nextDueDate
      let first = d;
      for (;;) {
        const prev = addYearsClamped(first, -1);
        if (compareDateOnly(prev, from) < 0) break;
        first = prev;
      }
      for (let cur = first; compareDateOnly(cur, to) <= 0; cur = addYearsClamped(cur, 1)) {
        push(cur);
      }
      break;
    }
  }
  out.sort(compareDateOnly);
  return [...new Set(out)];
}

/**
 * Enumerate occurrences in [from, to], applying skips, endDate,
 * remainingOccurrences, overrides and weekend shift.
 */
export function enumerateOccurrences(
  rule: RecurringRule,
  overrides: readonly RecurringOverride[],
  from: DateOnly,
  to: DateOnly,
): GeneratedOccurrence[] {
  // remainingOccurrences counts from the rule's nextDueDate forward.
  // nextDueDate is authoritative: the rule never fires before it. Clamp
  // the window UP to it — a rule whose next due date is in the future
  // (e.g. this month's bill is already paid) must not enumerate a
  // phantom occurrence for today. Overdue bills are still covered: the
  // catch-up materializes them as Scheduled rows from nextDueDate.
  const enumFrom = compareDateOnly(from, rule.nextDueDate) < 0 ? rule.nextDueDate : from;
  let dates = canonicalDates(rule, enumFrom, to);
  if (rule.remainingOccurrences !== undefined) {
    dates = dates.slice(0, Math.max(0, rule.remainingOccurrences));
  }
  const skipped = new Set(rule.skippedDates);
  const overrideByDate = new Map(overrides.map((o) => [o.occurrenceDate, o]));
  const out: GeneratedOccurrence[] = [];
  for (const occurrenceDate of dates) {
    if (compareDateOnly(occurrenceDate, from) < 0) continue;
    if (skipped.has(occurrenceDate)) continue;
    if (rule.endDate && compareDateOnly(occurrenceDate, rule.endDate) > 0) continue;
    const ov = overrideByDate.get(occurrenceDate);
    out.push({
      ruleId: rule.id,
      occurrenceDate,
      date: ov?.date ?? shiftWeekend(occurrenceDate, rule.weekendShift),
      amount: ov?.amount ?? rule.amount,
    });
  }
  return out;
}

/** Status for a freshly generated row. */
export function generatedStatus(rule: RecurringRule): TransactionStatus {
  if (rule.kind === "Income") return "Scheduled"; // payday confirmed later
  if (rule.isVariableAmount) return "Scheduled"; // invites amount confirmation
  return rule.autoPay ? "Pending" : "Scheduled";
}

export interface GenerationResult {
  transactions: Transaction[];
  lastGeneratedThrough: DateOnly;
  remainingOccurrences?: number;
}

/**
 * Generate transaction rows due since the rule's watermark, up to `through`.
 * Idempotent: rows already present (matched on ruleId + occurrenceDate)
 * are never regenerated, even if their editable `date` moved.
 */
export function generateDueTransactions(
  rule: RecurringRule,
  overrides: readonly RecurringOverride[],
  existing: readonly Transaction[],
  through: DateOnly,
  nowIso: string,
): GenerationResult {
  const from = rule.lastGeneratedThrough ? addDays(rule.lastGeneratedThrough, 1) : rule.nextDueDate;
  const occurrences = enumerateOccurrences(rule, overrides, from, through);
  const existingKeys = new Set(
    existing
      .filter((t) => t.recurringRuleId === rule.id && t.occurrenceDate)
      .map((t) => `${t.recurringRuleId}:${t.occurrenceDate}`),
  );
  const overrideByDate = new Map(overrides.map((o) => [o.occurrenceDate, o]));
  const transactions: Transaction[] = [];
  // Debt-payment rules (card or loan) generate Transfers — never Expenses —
  // from the source account to the debt account being paid.
  const isDebtPayment = rule.payToAccountId !== undefined && rule.payToAccountId !== "";
  for (const occ of occurrences) {
    if (existingKeys.has(`${rule.id}:${occ.occurrenceDate}`)) continue;
    const ov = overrideByDate.get(occ.occurrenceDate);
    const tx: Transaction = {
      id: crypto.randomUUID(),
      type: rule.kind === "Income" ? "Income" : isDebtPayment ? "Transfer" : "Expense",
      amount: occ.amount,
      currency: rule.currency,
      date: occ.date,
      accountId: ov?.accountId ?? rule.accountId,
      categoryId: isDebtPayment ? null : (ov?.categoryId ?? rule.categoryId),
      payee: rule.name,
      status: generatedStatus(rule),
      notes: "",
      tags: [],
      recurringRuleId: rule.id,
      occurrenceDate: occ.occurrenceDate,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    if (isDebtPayment) {
      tx.transferToAccountId = rule.payToAccountId;
    }
    transactions.push(tx);
  }
  return {
    transactions,
    lastGeneratedThrough: through,
    remainingOccurrences:
      rule.remainingOccurrences === undefined
        ? undefined
        : Math.max(0, rule.remainingOccurrences - transactions.length),
  };
}

/* ------------------------------------------------------------------ */
/* Annual cost and primary-payday helpers (Phase 5: Bills area)        */
/* ------------------------------------------------------------------ */

/**
 * The total this rule costs over the next 365 days: the sum of
 * occurrence amounts in [today, addDays(today, 365)], enumerated with
 * the real engine so endDate, skippedDates, remainingOccurrences, and
 * per-occurrence amount overrides are all honored. Pure integer
 * minor-unit addition only — no frequency math is hand-rolled here.
 */
export function annualCost(
  rule: RecurringRule,
  overrides: readonly RecurringOverride[],
  today: DateOnly,
): MinorUnits {
  const horizon = addDays(today, 365);
  const occurrences = enumerateOccurrences(rule, overrides, today, horizon);
  // GeneratedOccurrence.amount is semantically MinorUnits (integer math
  // throughout the engine); the cast just satisfies the type system.
  return sumMinor(occurrences.map((o) => o.amount as MinorUnits));
}

/**
 * Return a new rule list with `id` as the sole primary payday.
 * The switch only applies to kind === "Income" rules: when the given
 * id is not an Income rule, the list is returned with its primary
 * flags untouched. The returned array shares unchanged rule objects
 * with the input (only the toggled rules are copied).
 */
export function setPrimaryPayday(
  rules: readonly RecurringRule[],
  id: string,
  nowIso: string,
): RecurringRule[] {
  const target = rules.find((r) => r.id === id);
  if (!target || target.kind !== "Income") return [...rules];
  return rules.map((r) => {
    if (r.id === id) {
      return r.isPrimaryPayday ? r : { ...r, isPrimaryPayday: true, updatedAt: nowIso };
    }
    return r.isPrimaryPayday ? { ...r, isPrimaryPayday: false, updatedAt: nowIso } : r;
  });
}

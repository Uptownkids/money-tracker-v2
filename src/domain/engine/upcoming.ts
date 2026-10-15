/**
 * Upcoming: the 30-day outlook of bills and subscriptions.
 *
 * Pure and injectable: the caller loads rules, overrides and transactions
 * (no Dexie in here) and supplies the currency plumbing. Projected
 * occurrences merge with existing Scheduled transactions, deduped on the
 * canonical (recurringRuleId, occurrenceDate) key with the Scheduled row
 * winning — the same semantics as mergeCommittedBills in safeToSpend.ts,
 * reimplemented here because UpcomingItem carries display fields
 * (name, date, source) that MergedBill drops.
 *
 * Occurrences already settled (a Cleared/Pending row exists for the
 * occurrence) are excluded: marking a bill paid must not leave it listed
 * as upcoming via its projection.
 */
import type { DateOnly } from "../dates/dateOnly.js";
import { addDays, compareDateOnly } from "../dates/dateOnly.js";
import type { MinorUnits } from "../money/money.js";
import type {
  RecurringOverride,
  RecurringRule,
} from "../entities/recurringRule.js";
import type { Transaction } from "../entities/transaction.js";
import type { CurrencyConverter } from "./safeToSpend.js";
import { projectOccurrences } from "./projection.js";

/** Rolling outlook length in days, inclusive of both endpoints. */
export const UPCOMING_WINDOW_DAYS = 30;

export interface UpcomingItem {
  key: string;
  ruleId?: string;
  name: string;
  amount: MinorUnits; // base currency
  date: DateOnly; // effective payment date (post weekend-shift/override)
  occurrenceDate: DateOnly; // canonical occurrence date (identity)
  overdue: boolean;
  source: "projected" | "scheduled";
}

export interface BuildUpcomingInput {
  rules: readonly RecurringRule[]; // active rules; non-income filtered inside
  overridesByRule: Record<string, readonly RecurringOverride[]>;
  transactions: readonly Transaction[]; // full list; scheduled rows filtered inside
  today: DateOnly;
  convertToBase: CurrencyConverter;
  accountCurrencyOf: (accountId: string) => string;
}

export function buildUpcoming(input: BuildUpcomingInput): UpcomingItem[] {
  const { rules, overridesByRule, transactions, today, convertToBase, accountCurrencyOf } = input;
  const to = addDays(today, UPCOMING_WINDOW_DAYS);

  const billRules = rules.filter((r) => r.active && r.kind !== "Income");
  const rulesById = new Map(billRules.map((r) => [r.id, r]));
  const overrides = billRules.flatMap((r) => overridesByRule[r.id] ?? []);

  // Occurrences that already have a settled (non-Scheduled) row are done:
  // their projection must not linger in the outlook.
  const settledKeys = new Set(
    transactions
      .filter((t) => t.recurringRuleId && t.occurrenceDate && t.status !== "Scheduled")
      .map((t) => `${t.recurringRuleId}:${t.occurrenceDate}`),
  );

  const byKey = new Map<string, UpcomingItem>();

  for (const p of projectOccurrences(billRules, overrides, today, to)) {
    const key = `${p.ruleId}:${p.occurrenceDate}`;
    if (settledKeys.has(key)) continue;
    byKey.set(key, {
      key,
      ruleId: p.ruleId,
      name: rulesById.get(p.ruleId)?.name ?? "Bill",
      amount: convertToBase(p.amount, p.currency),
      date: p.date,
      occurrenceDate: p.occurrenceDate,
      overdue: compareDateOnly(p.date, today) < 0,
      source: "projected",
    });
  }

  for (const t of transactions) {
    if (t.status !== "Scheduled" || t.type === "Income") continue;
    if (compareDateOnly(t.date, to) > 0) continue;
    // Overdue rows (date < today) are included regardless of the
    // window start; only the window END filters them out.
    const key =
      t.recurringRuleId && t.occurrenceDate
        ? `${t.recurringRuleId}:${t.occurrenceDate}`
        : `tx:${t.id}`;
    // fx.baseAmount is denominated in the ACCOUNT's currency — convert
    // with accountCurrencyOf, never t.currency (see money/fx.ts).
    const amount = t.fx ? t.fx.baseAmount : t.amount;
    const currency = t.fx ? accountCurrencyOf(t.accountId) || t.currency : t.currency;
    byKey.set(key, {
      key,
      ruleId: t.recurringRuleId,
      name: t.payee,
      amount: convertToBase(amount, currency),
      date: t.date,
      occurrenceDate: t.occurrenceDate ?? t.date,
      overdue: compareDateOnly(t.date, today) < 0,
      source: "scheduled",
    });
  }

  const items = [...byKey.values()];
  items.sort(
    (a, b) =>
      compareDateOnly(a.date, b.date) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  return items;
}

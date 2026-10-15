/**
 * Pure projection of future rule occurrences.
 *
 * projectOccurrences answers "what will happen" without creating rows.
 * Safe-to-spend and Upcoming both consume it, so a bill that has not been
 * generated as a transaction yet still counts. Callers merge the result
 * with existing Scheduled transactions and dedupe on
 * (recurringRuleId, occurrenceDate).
 */
import type { DateOnly } from "../dates/dateOnly.js";
import type { MinorUnits } from "../money/money.js";
import type {
  RecurringKind,
  RecurringOverride,
  RecurringRule,
} from "../entities/recurringRule.js";
import { enumerateOccurrences } from "./recurringEngine.js";

export interface ProjectedOccurrence {
  ruleId: string;
  occurrenceDate: DateOnly;
  date: DateOnly; // after weekend shift / override
  amount: MinorUnits;
  /** Currency of the amount (from the rule). Additive to the Phase 1 doc. */
  currency: string;
  kind: RecurringKind;
  /** True when the rule is a debt payment (card or loan): keyed on the
   * rule's payToAccountId. Debt-payment rows are Transfers, never
   * Expenses — for both cards and loans. Card and loan payments are
   * treated identically: the minimum due lands in committed, and no
   * balance is ever subtracted from available. */
  isDebtPayment: boolean;
}

export function projectOccurrences(  rules: readonly RecurringRule[],
  overrides: readonly RecurringOverride[],
  from: DateOnly,
  to: DateOnly,
): ProjectedOccurrence[] {
  const out: ProjectedOccurrence[] = [];
  for (const rule of rules) {
    if (!rule.active) continue;
    for (const occ of enumerateOccurrences(rule, overrides, from, to)) {
      const payTo =
        rule.payToAccountId !== undefined && rule.payToAccountId !== ""
          ? rule.payToAccountId
          : null;
      out.push({
        ruleId: rule.id,
        occurrenceDate: occ.occurrenceDate,
        date: occ.date,
        amount: occ.amount,
        currency: rule.currency,
        kind: rule.kind,
        isDebtPayment: payTo !== null,
      });
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

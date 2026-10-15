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
import type { Account } from "../entities/account.js";
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
  isCreditCardPayment: boolean;
  /** True when the rule is a debt payment (card or loan): keyed on the
   * rule's payToAccountId. Debt-payment rows are Transfers, never
   * Expenses — for both cards and loans. */
  isDebtPayment: boolean;
  /** True when this occurrence is a payment TO A CREDIT CARD (destination
   * account type is CreditCard) or the legacy isCreditCardPayment flag is
   * set. Only card payments are excluded from committed: the card balance
   * is already subtracted from available, so counting the payment would
   * double-count the same money. Loan payments stay in committed — loan
   * balances are NOT subtracted from available, so the minimum must be
   * set aside. */
  isCardPayment: boolean;
}

/**
 * True when the rule's debt payment goes TO A CREDIT CARD (or carries the
 * legacy isCreditCardPayment flag). Only card payments are excluded from
 * committed: the card balance is already subtracted from available.
 * Loan-payment rules return false — loan balances are NOT subtracted from
 * available, so the minimum must stay in committed. A payToAccountId that
 * points at a missing account is treated as non-card (safe default: the
 * payment stays set aside).
 */
export function isCardPaymentRule(
  rule: RecurringRule,
  accountTypeOf: (accountId: string) => Account["type"] | undefined,
): boolean {
  return (
    rule.isCreditCardPayment === true ||
    (rule.payToAccountId !== undefined &&
      rule.payToAccountId !== "" &&
      accountTypeOf(rule.payToAccountId) === "CreditCard")
  );
}

export function projectOccurrences(  rules: readonly RecurringRule[],
  overrides: readonly RecurringOverride[],
  from: DateOnly,
  to: DateOnly,
  accountTypeOf?: (accountId: string) => Account["type"] | undefined,
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
        isCreditCardPayment: rule.isCreditCardPayment ?? false,
        isDebtPayment: payTo !== null,
        isCardPayment: isCardPaymentRule(rule, (id) => accountTypeOf?.(id)),
      });
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

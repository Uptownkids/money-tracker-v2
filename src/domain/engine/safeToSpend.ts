/**
 * Safe-to-spend calculator: the daily coach number.
 *
 *   available = spendable balances - credit-card balances owed + counted IOUs
 *   committed = projected bills/subscriptions due <= next payday
 *             + existing Scheduled bills (deduped)
 *             + goal commitments + buffer
 *   daily     = floor((available - committed) / daysLeft), rounded DOWN
 *               to the whole currency unit. Never negative: a shortfall
 *               becomes deficit mode instead.
 */
import type { DateOnly } from "../dates/dateOnly.js";
import { diffDays } from "../dates/dateOnly.js";
import type { MinorUnits } from "../money/money.js";
import { maxZero, roundDownToUnit, subMinor, sumMinor } from "../money/money.js";
import { decimalsOf } from "../money/currency.js";
import type { Account } from "../entities/account.js";
import type { Transaction } from "../entities/transaction.js";
import { affectsBalance } from "../entities/transaction.js";
import type { DailySnapshot } from "../entities/settings.js";
import type { ProjectedOccurrence } from "./projection.js";

/** Converts a minor-unit amount in the given currency to base currency. */
export type CurrencyConverter = (
  amountMinor: MinorUnits,
  currency: string,
  account?: Account,
) => MinorUnits;

/** Converts one transaction's effective amount to base currency. */
export type TransactionToBase = (t: Transaction) => MinorUnits;

/**
 * Default transaction-to-base: the frozen FX amount when present (already
 * in the account's currency), otherwise the raw amount. The caller supplies
 * the account-currency lookup; see the currency semantics note in
 * money/fx.ts — never convert fx.baseAmount with t.currency.
 */
export function defaultTransactionToBase(
  accountCurrencyOf: (accountId: string) => string,
  convertToBase: CurrencyConverter,
): TransactionToBase {
  return (t) =>
    convertToBase(
      t.fx ? t.fx.baseAmount : t.amount,
      t.fx ? accountCurrencyOf(t.accountId) : t.currency,
    );
}

export interface SafeToSpendInput {
  today: DateOnly;
  accounts: Account[];
  balances: Record<string, MinorUnits>; // per account, in account currency
  // Projected occurrences due <= next payday (incl. overdue), merged with
  // existing Scheduled transactions and deduped on
  // (recurringRuleId, occurrenceDate). Debt-payment projections (card or
  // loan, keyed on the rule's payToAccountId) are excluded here. Amounts
  // are converted from `currency` (defaults to the base currency when absent).
  projectedBills: ProjectedOccurrence[];
  scheduledBills: Transaction[]; // pre-filtered: card-payment rows excluded
  // Sum over active goals of committedPerGoal =
  // earmarkedInSpendable + max(0, thisCycleContribution - fundedThisCycle).
  // Contributions already transferred out of spendable this cycle are
  // never subtracted again.
  goalContributions: MinorUnits;
  countedIous: MinorUnits; // "count on it" IOUs due before payday
  buffer: MinorUnits;
  // Sum of today's Cleared/Pending expense transactions (base currency),
  // used only for leftToday. Supplied by the caller so the calculator
  // stays pure.
  todaySpending: MinorUnits;
  nextPayday: DateOnly | null; // null -> 30-day rolling window
  baseCurrency: string;
  convertToBase: CurrencyConverter;
  // Account-currency lookup for Scheduled rows carrying fx (their
  // fx.baseAmount is denominated in the account's currency). Defaults to
  // base currency when the caller has no account map.
  accountCurrencyOf?: (accountId: string) => string;
}

export interface SafeToSpendResult {
  mode: "normal" | "deficit" | "no-payday-window";
  dailyAmount: MinorUnits; // 0 in deficit; never negative
  leftToday: MinorUnits; // dailyAmount minus todaySpending
  available: MinorUnits;
  committed: MinorUnits;
  daysLeft: number; // today through day before payday, min 1
  shortfall?: MinorUnits; // deficit only: committed - available
  windowLabel?: string; // e.g. "30-day window (no payday set)"
}

export interface MergedBill {
  amount: MinorUnits; // base currency
  ruleId?: string;
  occurrenceDate?: DateOnly;
}

/**
 * Merge projected occurrences with existing Scheduled transactions,
 * deduped on (recurringRuleId, occurrenceDate). The Scheduled row wins
 * on conflict (it may carry an edited amount). Debt-payment projections
 * (card and loan alike) are included: only the minimum due is committed,
 * never the full balance.
 *
 * Currency: projected amounts are in the rule's currency (rules belong to
 * one account, so this is the account currency). Scheduled rows use
 * fx.baseAmount when present — which is denominated in the ACCOUNT's
 * currency, so it converts with accountCurrencyOf, never t.currency.
 */
export function mergeCommittedBills(
  projectedBills: readonly ProjectedOccurrence[],
  scheduledBills: readonly Transaction[],
  convertToBase: CurrencyConverter,
  accountCurrencyOf: (accountId: string) => string = () => "",
): MergedBill[] {
  const byKey = new Map<string, MergedBill>();
  for (const p of projectedBills) {
    byKey.set(`${p.ruleId}:${p.occurrenceDate}`, {
      amount: convertToBase(p.amount, p.currency),
      ruleId: p.ruleId,
      occurrenceDate: p.occurrenceDate,
    });
  }
  for (const t of scheduledBills) {
    if (t.status !== "Scheduled") continue;
    const key =
      t.recurringRuleId && t.occurrenceDate ? `${t.recurringRuleId}:${t.occurrenceDate}` : `tx:${t.id}`;
    const amount = t.fx ? t.fx.baseAmount : t.amount;
    const currency = t.fx ? accountCurrencyOf(t.accountId) || t.currency : t.currency;
    byKey.set(key, {
      amount: convertToBase(amount, currency),
      ruleId: t.recurringRuleId,
      occurrenceDate: t.occurrenceDate,
    });
  }
  return [...byKey.values()];
}

/**
 * Today's true discretionary spending: Cleared/Pending expenses dated
 * today, EXCLUDING (a) transactions settling a recurring occurrence
 * (recurringRuleId set — already counted in committed) and (b) expenses
 * with a goalId (already earmarked in committed). Without these
 * exclusions, marking a bill paid would wrongly turn "Left today" red.
 */
export function computeTodaySpending(
  transactions: readonly Transaction[],
  today: DateOnly,
  toBase: TransactionToBase,
  transferCategoryIds: ReadonlySet<string> = new Set<string>(),
): MinorUnits {
  return sumMinor(
    transactions
      .filter(
        (t) =>
          t.type === "Expense" &&
          t.date === today &&
          affectsBalance(t) &&
          !t.recurringRuleId &&
          !t.goalId &&
          !(t.categoryId != null && transferCategoryIds.has(t.categoryId)),
      )
      .map(toBase),
  );
}

export function calculateSafeToSpend(input: SafeToSpendInput): SafeToSpendResult {
  const {
    today,
    accounts,
    balances,
    projectedBills,
    scheduledBills,
    goalContributions,
    countedIous,
    buffer,
    todaySpending,
    nextPayday,
    baseCurrency,
    convertToBase,
    accountCurrencyOf,
  } = input;

  // available = spendable balances + counted IOUs. Card and loan balances
  // are never subtracted: only the minimum due is committed (via the
  // debt-payment rules), so the daily number reflects minimums, not a
  // full payoff.
  let spendableBase = 0;
  for (const a of accounts) {
    const bal = balances[a.id] ?? 0;
    const base = convertToBase(bal, a.currency, a);
    if (a.countsAsSpendable) {
      spendableBase = spendableBase + base;
    }
  }
  const available = spendableBase + countedIous;

  // committed = bills + goals + buffer
  const merged = mergeCommittedBills(
    projectedBills,
    scheduledBills,
    convertToBase,
    accountCurrencyOf,
  );
  const billsTotal = sumMinor(merged.map((m) => m.amount));
  const committed = sumMinor([billsTotal, goalContributions, buffer]);

  const daysLeft = nextPayday === null ? 30 : Math.max(1, diffDays(today, nextPayday));
  const net = subMinor(available, committed);

  if (net < 0) {
    return {
      mode: "deficit",
      dailyAmount: 0,
      leftToday: subMinor(0, todaySpending),
      available,
      committed,
      daysLeft,
      shortfall: subMinor(committed, available),
    };
  }

  const decimals = decimalsOf(baseCurrency);
  const dailyAmount = roundDownToUnit(Math.floor(net / daysLeft), decimals);
  return {
    mode: nextPayday === null ? "no-payday-window" : "normal",
    dailyAmount: maxZero(dailyAmount),
    leftToday: subMinor(dailyAmount, todaySpending),
    available,
    committed,
    daysLeft,
    windowLabel: nextPayday === null ? "30-day window (no payday set)" : undefined,
  };
}

/** Build (or rebuild) today's DailySnapshot from a calculator result. */
export function createDailySnapshot(date: DateOnly, result: SafeToSpendResult, nowIso: string): DailySnapshot {
  return {
    id: date,
    date,
    startOfDayAmount: result.dailyAmount,
    available: result.available,
    committed: result.committed,
    daysLeft: result.daysLeft,
    createdAt: nowIso,
  };
}

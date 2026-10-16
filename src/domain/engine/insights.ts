/**
 * Insights engine: read-only aggregate statistics over transactions,
 * accounts, goals, IOUs, and subscription rules.
 *
 * All amounts are integer minor units unless a value is explicitly a
 * ratio or a day count. Dates are UTC DateOnly strings; only DateOnly
 * helpers are used for month arithmetic (never local-time functions).
 *
 * Multi-currency: every aggregate that sums transactions takes a
 * `toBase` converter (the frozen FX amount is already honored by
 * defaultTransactionToBase; see safeToSpend.ts). The identity default
 * keeps the math currency-consistent for single-currency callers and
 * for tests.
 */
import type { DateOnly } from "../dates/dateOnly.js";
import { addDays, compareDateOnly } from "../dates/dateOnly.js";
import type { MinorUnits } from "../money/money.js";
import { addMinor, maxZero, roundDownToUnit, subMinor, sumMinor } from "../money/money.js";
import { decimalsOf } from "../money/currency.js";
import type { Account } from "../entities/account.js";
import type { Category } from "../entities/category.js";
import type { Goal } from "../entities/goal.js";
import type { RecurringOverride, RecurringRule } from "../entities/recurringRule.js";
import type { DailySnapshot } from "../entities/settings.js";
import type { Split } from "../entities/split.js";
import type { Transaction } from "../entities/transaction.js";
import { affectsBalance, countsAsIncome } from "../entities/transaction.js";
import { computeTodaySpending, type TransactionToBase } from "./safeToSpend.js";
import { deriveGoalSaved, type AccountsById } from "./goals.js";
import { annualCost } from "./recurringEngine.js";

/** Raw amount converter: fx.baseAmount when frozen FX is present, else amount. */
export const rawTxAmount: TransactionToBase = (t) => (t.fx ? t.fx.baseAmount : t.amount);

type MonthKey = `${number}-${string}`; // "YYYY-MM"

/** "2026-10-15" -> "2026-10". */
function monthOfDate(d: DateOnly): string {
  return d.slice(0, 7);
}

/** Shift a "YYYY-MM" key by n months (UTC math, no local-time calls). */
export function shiftMonthKey(month: string, n: number): string {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)); // 1-12
  const total = year * 12 + (m - 1) + n;
  const y = Math.floor(total / 12);
  const mm = (total % 12) + 1;
  return `${String(y).padStart(4, "0")}-${String(mm).padStart(2, "0")}` as MonthKey;
}

/**
 * Net outflow for cash-flow math: expenses MINUS refunds. Refunds always
 * net against expenses, never against income. Transfers are excluded
 * entirely (including debt-payment Transfers, which move money between
 * accounts rather than spending it). Only affectsBalance rows
 * (Cleared/Pending) count; Scheduled rows never count.
 */
function outflowOf(
  transactions: readonly Transaction[],
  inMonth: (t: Transaction) => boolean,
  toBase: TransactionToBase,
): MinorUnits {
  const expenses = sumMinor(
    transactions
      .filter((t) => t.type === "Expense" && inMonth(t) && affectsBalance(t))
      .map(toBase),
  );
  const refunds = sumMinor(
    transactions
      .filter((t) => t.type === "Refund" && inMonth(t) && affectsBalance(t))
      .map(toBase),
  );
  return subMinor(expenses, refunds);
}

function incomeOf(
  transactions: readonly Transaction[],
  inMonth: (t: Transaction) => boolean,
  toBase: TransactionToBase,
): MinorUnits {
  return sumMinor(
    transactions
      .filter((t) => countsAsIncome(t) && inMonth(t) && affectsBalance(t))
      .map(toBase),
  );
}

export interface MonthlyCashFlow {
  income: MinorUnits;
  expenses: MinorUnits; // expenses net of refunds
  net: MinorUnits; // income - expenses
}

/**
 * Cash flow for one month ("YYYY-MM"): earned income, expenses net of
 * refunds, and the net. Income rows carrying a splitId are IOU-settlement
 * inflows, not earned income (countsAsIncome), so they are excluded.
 */
export function monthlyCashFlow(
  transactions: readonly Transaction[],
  month: string,
  toBase: TransactionToBase = rawTxAmount,
): MonthlyCashFlow {
  const inMonth = (t: Transaction): boolean => monthOfDate(t.date) === month;
  const income = incomeOf(transactions, inMonth, toBase);
  const expenses = outflowOf(transactions, inMonth, toBase);
  return { income, expenses, net: subMinor(income, expenses) };
}

export interface CategorySpending {
  categoryId: string | null;
  name: string;
  amount: MinorUnits; // net of refunds
}

/**
 * Spending by category for one month, sorted descending. Expenses net
 * against refunds; a refund carrying refundOfTransactionId reduces the
 * linked expense's category, and a refund with no link (or a link that
 * cannot be found) reduces the Uncategorized bucket. Zero-net buckets
 * are dropped so the chart stays clean.
 */
export function spendingByCategory(
  transactions: readonly Transaction[],
  month: string,
  categories: readonly Category[],
  toBase: TransactionToBase = rawTxAmount,
): CategorySpending[] {
  const byId = new Map<string, Transaction>();
  for (const t of transactions) byId.set(t.id, t);
  const names = new Map<string, string>();
  for (const c of categories) names.set(c.id, c.name);

  const totals = new Map<string | null, MinorUnits>();
  const add = (key: string | null, amount: MinorUnits) => {
    totals.set(key, addMinor(totals.get(key) ?? 0, amount));
  };

  for (const t of transactions) {
    if (monthOfDate(t.date) !== month || !affectsBalance(t)) continue;
    const amt = toBase(t);
    if (t.type === "Expense") {
      add(t.categoryId, amt);
    } else if (t.type === "Refund") {
      // Refunds subtract from the linked expense's category so category
      // totals reflect money truly spent.
      const linked = t.refundOfTransactionId ? byId.get(t.refundOfTransactionId) : undefined;
      const key = linked && linked.type === "Expense" ? linked.categoryId : null;
      add(key, -amt);
    }
  }

  const rows: CategorySpending[] = [];
  for (const [categoryId, amount] of totals) {
    if (amount === 0) continue;
    rows.push({
      categoryId,
      name: categoryId === null ? "Uncategorized" : (names.get(categoryId) ?? "Uncategorized"),
      amount,
    });
  }
  rows.sort((a, b) => b.amount - a.amount);
  return rows;
}

export interface MonthBucket {
  month: string; // "YYYY-MM"
  income: MinorUnits;
  outflow: MinorUnits; // expenses net of refunds
}

/**
 * Per-month income vs outflow for `months` months ending at endMonth
 * (inclusive), oldest first. Same income/outflow semantics as
 * monthlyCashFlow.
 */
export function incomeVsOutflow(
  transactions: readonly Transaction[],
  endMonth: string,
  months = 12,
  toBase: TransactionToBase = rawTxAmount,
): MonthBucket[] {
  const out: MonthBucket[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const month = shiftMonthKey(endMonth, -i);
    const inMonth = (t: Transaction): boolean => monthOfDate(t.date) === month;
    out.push({
      month,
      income: incomeOf(transactions, inMonth, toBase),
      outflow: outflowOf(transactions, inMonth, toBase),
    });
  }
  return out;
}

export interface Runway {
  liquid: MinorUnits; // spendable balances, base currency
  avgDailySpending: MinorUnits; // trailing 30 days, net of refunds
  days: number | null; // floor of liquid / avgDailySpending; null when nothing spent yet
}

/**
 * Runway: how long spendable money lasts at the trailing-30-day pace.
 * liquid = balances of accounts with countsAsSpendable, converted with
 * balanceToBase. avgDailySpending = trailing-30-day expenses net of
 * refunds (Cleared/Pending only, Transfers excluded) / 30. days is
 * floored to whole days; when avgDailySpending is 0, days is null and
 * the UI says there is no spending history yet.
 */
export function runway(
  accounts: readonly Account[],
  balances: Record<string, MinorUnits>,
  transactions: readonly Transaction[],
  today: DateOnly,
  toBase: TransactionToBase = rawTxAmount,
  balanceToBase: (balance: MinorUnits, account: Account) => MinorUnits = (b) => b,
): Runway {
  let liquid: MinorUnits = 0;
  for (const a of accounts) {
    if (!a.countsAsSpendable) continue;
    liquid = addMinor(liquid, balanceToBase(balances[a.id] ?? 0, a));
  }
  const windowStart = addDays(today, -29); // 30 days ending today, inclusive
  const windowed = transactions.filter(
    (t) => compareDateOnly(t.date, windowStart) >= 0 && compareDateOnly(t.date, today) <= 0,
  );
  const trailing30 = outflowOf(windowed, () => true, toBase);
  const avgDailySpending = Math.max(0, trailing30) / 30;
  if (avgDailySpending === 0) {
    return { liquid, avgDailySpending: 0, days: null };
  }
  return { liquid, avgDailySpending, days: Math.floor(liquid / avgDailySpending) };
}

export type DayStatus = "under" | "over";

export interface SpendingHistoryDay {
  date: DateOnly;
  budget: MinorUnits;
  spent: MinorUnits;
  status: DayStatus;
}

export interface SpendingHistory {
  days: SpendingHistoryDay[]; // ascending by date
  under: number;
  over: number;
}

/**
 * How past days went against their start-of-day number. For each
 * DailySnapshot, the implied daily budget mirrors calculateSafeToSpend's
 * dailyAmount formula exactly: floor((available - committed) / daysLeft),
 * rounded DOWN to the whole currency unit, never negative. spent is
 * computeTodaySpending for that date. Boundary: spent == budget counts
 * as under.
 */
export function spendingHistory(
  snapshots: readonly DailySnapshot[],
  transactions: readonly Transaction[],
  toBase: TransactionToBase,
  baseCurrency: string,
): SpendingHistory {
  const decimals = decimalsOf(baseCurrency);
  const sorted = [...snapshots].sort((a, b) => compareDateOnly(a.date, b.date));
  const days: SpendingHistoryDay[] = [];
  let under = 0;
  let over = 0;
  for (const s of sorted) {
    const daysLeft = Math.max(1, s.daysLeft);
    const budget = maxZero(
      roundDownToUnit(Math.floor(subMinor(s.available, s.committed) / daysLeft), decimals),
    );
    const spent = computeTodaySpending(transactions, s.date, toBase);
    const status: DayStatus = spent <= budget ? "under" : "over";
    if (status === "under") under += 1;
    else over += 1;
    days.push({ date: s.date, budget, spent, status });
  }
  return { days, under, over };
}

export interface GoalProgress {
  goal: Goal;
  saved: MinorUnits;
  pct: number; // 0-100, clamped; 0 when the target is 0
}

/** Goal progress bars: saved via deriveGoalSaved, pct clamped 0-100. */
export function goalProgress(
  goals: readonly Goal[],
  transactions: readonly Transaction[],
  toBase: TransactionToBase = rawTxAmount,
  accountsById?: AccountsById,
): GoalProgress[] {
  return goals.map((goal) => {
    const saved = deriveGoalSaved(goal.id, transactions, undefined, toBase, accountsById);
    const pct =
      goal.targetAmount > 0
        ? Math.min(100, Math.max(0, (saved / goal.targetAmount) * 100))
        : 0;
    return { goal, saved, pct };
  });
}

export interface OutstandingIous {
  owedToYou: MinorUnits; // unsettled TheyOweMe splits
  youOwe: MinorUnits; // unsettled IOweThem splits
}

/**
 * Outstanding IOUs by direction. Outstanding means unsettled, regardless
 * of countOnIt (countOnIt only drives safe-to-spend, not this tally).
 */
export function outstandingIous(
  splits: readonly Split[],
  convert: (amount: MinorUnits, currency: string) => MinorUnits = (a) => a,
): OutstandingIous {
  let owedToYou: MinorUnits = 0;
  let youOwe: MinorUnits = 0;
  for (const s of splits) {
    if (s.settled) continue;
    const amt = convert(s.amount, s.currency);
    if (s.direction === "TheyOweMe") owedToYou = addMinor(owedToYou, amt);
    else if (s.direction === "IOweThem") youOwe = addMinor(youOwe, amt);
  }
  return { owedToYou, youOwe };
}

export interface SubscriptionTotals {
  perMonth: MinorUnits;
  perYear: MinorUnits;
}

/**
 * Subscription cost totals from ACTIVE rules with kind "Subscription".
 * perYear sums annualCost(rule, overrides, today) over those rules;
 * perMonth rounds perYear / 12.
 */
export function subscriptionTotals(
  rules: readonly RecurringRule[],
  overrides: readonly RecurringOverride[],
  today: DateOnly,
): SubscriptionTotals {
  const perYear = sumMinor(
    rules
      .filter((r) => r.active && r.kind === "Subscription")
      .map((r) => annualCost(r, overrides, today)),
  );
  return { perYear, perMonth: Math.round(perYear / 12) };
}

/** Re-export netWorth so Insights has one import point for worth math. */
export { netWorth } from "./balances.js";

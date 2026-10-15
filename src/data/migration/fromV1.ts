/**
 * One-time migration from the v1 Money Tracker.
 *
 * Reads a plain JSON object shaped like the v1 getDashboard response and
 * returns v2 entities. Pure and testable: it never touches the database.
 * The caller writes the result after the user confirms the JSON backup
 * download (a browser app cannot write a backup file silently).
 *
 * v1 dashboard shape (all amounts in dollars as floats):
 * {
 *   bills: [{ id, name, amount, due_day }],
 *   debts: [{ id, name, current_balance, minimum_payment, due_day, due_label }],
 *   expenses: [{ id, amount, category, expense_date, note }],
 *   settings: { current_cash, savings_per_paycheck, savings_goal,
 *               paycheck_amount, payday_one, payday_two, ... },
 *   savings_total, trip_expenses: [{...same as expenses}], bill_payments: []
 * }
 */
import {
  DateOnly,
  addDays,
  clampDayOfMonth,
  compareDateOnly,
  monthOf,
  yearOf,
} from "../../domain/dates/dateOnly.js";
import { DEFAULT_CATEGORIES, type Category } from "../../domain/entities/category.js";
import type { Account, AccountType } from "../../domain/entities/account.js";
import { toStoredBalance } from "../../domain/entities/account.js";
import type { Transaction } from "../../domain/entities/transaction.js";
import type { Goal } from "../../domain/entities/goal.js";
import type { RecurringRule } from "../../domain/entities/recurringRule.js";
import type { Split } from "../../domain/entities/split.js";
import type { MinorUnits } from "../../domain/money/money.js";

export interface V1Bill {
  id: number;
  name: string;
  amount: number;
  due_day: number | null;
}

export interface V1Debt {
  id: number;
  name: string;
  current_balance: number;
  minimum_payment: number;
  due_day: number | null;
  due_label: string;
}

export interface V1Expense {
  id: number;
  amount: number;
  category: string;
  expense_date: string;
  note: string;
}

export interface V1Settings {
  current_cash: number;
  savings_per_paycheck: number;
  savings_goal: number;
  paycheck_amount: number;
  payday_one: number;
  payday_two: number;
  [key: string]: unknown;
}

export interface V1Dashboard {
  bills: V1Bill[];
  debts: V1Debt[];
  expenses: V1Expense[];
  settings: V1Settings;
  savings_total: number;
  trip_expenses: V1Expense[];
  bill_payments: Array<{ bill_id: number; amount: number; paid_date: string }>;
}

export interface MigrationOptions {
  /** Calendar date the migration runs (entity timestamps + startingDate). */
  migrationDate: DateOnly;
  /** ISO timestamp for createdAt/updatedAt. */
  nowIso: string;
  /**
   * v1 debts carry no account-type info. Names matching /credit/i default
   * to CreditCard, everything else to Other (loan). Override per debt
   * name here when the heuristic is wrong.
   */
  debtAccountTypes?: Record<string, AccountType>;
  /**
   * LA trip float goal options (the trip is UPCOMING). The goal target is
   * always the fixed LA_TRIP_FLOAT_TARGET_MINOR; these options only set
   * the target date and how much is already set aside.
   */
  tripGoal?: {
    /** The day the user leaves; the goal's target date (optional). */
    targetDate?: DateOnly;
    /** Amount already set aside for the trip, in minor units. */
    setAsideMinor: MinorUnits;
  };
}

/**
 * Fixed target for the migrated "LA trip float" goal, in minor units.
 * Malike fixed this 2026-10-15: the old migration set the target to the
 * SUM of already-logged trip expenses, which is wrong — that money is
 * already spent. The float is a fixed $570 for the upcoming trip.
 */
export const LA_TRIP_FLOAT_TARGET_MINOR: MinorUnits = 57000;

export interface MigrationResult {
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  recurringRules: RecurringRule[];
  goals: Goal[];
  splits: Split[];
  warnings: string[];
}

/** dollars (float) -> integer minor units, rounded. */
export function dollarsToMinor(dollars: number): number {
  if (!Number.isFinite(dollars)) throw new RangeError(`dollarsToMinor: not finite: ${dollars}`);
  return Math.round(dollars * 100);
}

/** Next date on/after `from` with the given day-of-month (clamped). */
function nextDomOnOrAfter(from: DateOnly, dom: number): DateOnly {
  const y = yearOf(from);
  const m = monthOf(from);
  const thisMonth = clampDayOfMonth(y, m, dom);
  if (compareDateOnly(thisMonth, from) >= 0) return thisMonth;
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  return clampDayOfMonth(ny, nm, dom);
}

function makeCategory(name: string, kind: Category["kind"], nowIso: string): Category {
  return {
    id: crypto.randomUUID(),
    name,
    kind,
    icon: "dots",
    color: "slate",
    archived: false,
  };
}

export function migrateFromV1(v1: V1Dashboard, opts: MigrationOptions): MigrationResult {
  const { migrationDate, nowIso } = opts;
  const warnings: string[] = [];
  const accounts: Account[] = [];
  const categories: Category[] = DEFAULT_CATEGORIES.map((c) => ({
    id: crypto.randomUUID(),
    ...c,
    archived: false,
  }));
  const transactions: Transaction[] = [];
  const recurringRules: RecurringRule[] = [];
  const goals: Goal[] = [];

  const categoryByName = new Map(categories.map((c) => [c.name.toLowerCase(), c]));
  const ensureCategory = (name: string, kind: Category["kind"] = "expense"): Category => {
    const existing = categoryByName.get(name.toLowerCase());
    if (existing) return existing;
    const created = makeCategory(name, kind, nowIso);
    categories.push(created);
    categoryByName.set(name.toLowerCase(), created);
    return created;
  };

  const mkAccount = (
    name: string,
    type: AccountType,
    startingBalance: number,
    countsAsSpendable: boolean,
  ): Account => {
    const a: Account = {
      id: crypto.randomUUID(),
      name,
      type,
      currency: "USD",
      startingBalance,
      startingDate: migrationDate,
      countsAsSpendable,
      archived: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    accounts.push(a);
    return a;
  };

  const mkRule = (r: Omit<RecurringRule, "id" | "createdAt" | "updatedAt">): RecurringRule => {
    const rule: RecurringRule = {
      ...r,
      id: crypto.randomUUID(),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    recurringRules.push(rule);
    return rule;
  };

  // 1. Cash in hand -> Cash account
  const cash = mkAccount("Cash", "Cash", dollarsToMinor(v1.settings.current_cash ?? 0), true);

  // Optional savings balance
  if ((v1.savings_total ?? 0) > 0) {
    mkAccount("Savings", "Savings", dollarsToMinor(v1.savings_total), false);
  }

  const otherCat = ensureCategory("Other");

  // 2. Debts -> liability accounts + minimum-payment Bill rules
  const debtTypeFor = (name: string): AccountType => {
    const override = opts.debtAccountTypes?.[name];
    if (override) return override;
    return /credit/i.test(name) ? "CreditCard" : "Loan";
  };
  let totalDebtMinor = 0;
  for (const d of v1.debts) {
    const type = debtTypeFor(d.name);
    const balanceMinor = dollarsToMinor(d.current_balance);
    totalDebtMinor += balanceMinor;
    // v1 debts are amounts owed (positive in); toStoredBalance stores
    // liabilities (credit cards and loans) negative.
    const liability = mkAccount(d.name, type, toStoredBalance(type, balanceMinor), false);
    mkRule({
      kind: "Bill",
      name: `${d.name} minimum`,
      amount: dollarsToMinor(d.minimum_payment),
      currency: "USD",
      accountId: cash.id,
      categoryId: otherCat.id,
      frequency: "monthly",
      nextDueDate: d.due_day ? nextDomOnOrAfter(migrationDate, d.due_day) : migrationDate,
      weekendShift: "none",
      autoPay: false,
      reminderOffsetDays: 3,
      isCreditCardPayment: type === "CreditCard",
      // Debt payments are Transfers to the liability account, never
      // expenses — set for both cards and loans.
      payToAccountId: liability.id,
      skippedDates: [],
      active: true,
    });
  }

  // 3. Extra debt payoff goal (priority 1)
  if (totalDebtMinor > 0) {
    goals.push({
      id: crypto.randomUUID(),
      name: "Extra debt payoff",
      targetAmount: totalDebtMinor,
      currency: "USD",
      targetDate: addDays(migrationDate, 365),
      contributionPerCycleOverride: undefined,
      pinnedContribution: null,
      priority: 1,
      paused: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }

  // 4. Bills -> monthly Bill rules (null due_day -> 1st of month)
  for (const b of v1.bills) {
    mkRule({
      kind: "Bill",
      name: b.name,
      amount: dollarsToMinor(b.amount),
      currency: "USD",
      accountId: cash.id,
      categoryId: ensureCategory(b.name).id,
      frequency: "monthly",
      nextDueDate: b.due_day ? nextDomOnOrAfter(migrationDate, b.due_day) : nextDomOnOrAfter(migrationDate, 1),
      weekendShift: "none",
      autoPay: false,
      reminderOffsetDays: 3,
      skippedDates: [],
      active: true,
    });
  }

  // 5. Expenses -> Expense transactions (Cleared, on the cash account)
  const mkExpense = (e: V1Expense, tags: string[]): void => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.expense_date)) {
      warnings.push(`Skipped expense #${e.id}: invalid date ${e.expense_date}`);
      return;
    }
    transactions.push({
      id: crypto.randomUUID(),
      type: "Expense",
      amount: dollarsToMinor(e.amount),
      currency: "USD",
      date: e.expense_date,
      accountId: cash.id,
      categoryId: ensureCategory(e.category || "Other").id,
      payee: e.note || e.category || "Expense",
      status: "Cleared",
      notes: e.note || "",
      tags,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  };
  for (const e of v1.expenses) mkExpense(e, []);
  for (const e of v1.trip_expenses) mkExpense(e, ["la-trip"]);

  // 6. Bill payments -> Expense transactions
  const billById = new Map(v1.bills.map((b) => [b.id, b]));
  for (const p of v1.bill_payments ?? []) {
    const bill = billById.get(p.bill_id);
    transactions.push({
      id: crypto.randomUUID(),
      type: "Expense",
      amount: dollarsToMinor(p.amount),
      currency: "USD",
      date: p.paid_date,
      accountId: cash.id,
      categoryId: ensureCategory(bill?.name ?? "Other").id,
      payee: bill?.name ?? "Bill payment",
      status: "Cleared",
      notes: "",
      tags: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }

  // 7. Emergency fund goal (priority 2) from savings settings
  const savingsTarget = dollarsToMinor(v1.settings.savings_goal ?? 0);
  if (savingsTarget > 0) {
    goals.push({
      id: crypto.randomUUID(),
      name: "Emergency fund",
      targetAmount: savingsTarget,
      currency: "USD",
      targetDate: addDays(migrationDate, 730),
      contributionPerCycleOverride: dollarsToMinor(v1.settings.savings_per_paycheck ?? 0) || undefined,
      pinnedContribution: null,
      priority: 2,
      paused: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }

  // 8. LA trip float goal (priority 3). The trip is UPCOMING, so the
  // target is the fixed LA_TRIP_FLOAT_TARGET_MINOR. Logged trip
  // expenses are past spending (still migrated as la-trip expenses) and
  // never raise the target.
  if ((v1.trip_expenses ?? []).length > 0) {
    const tripGoal: Goal = {
      id: crypto.randomUUID(),
      name: "LA trip float",
      targetAmount: LA_TRIP_FLOAT_TARGET_MINOR,
      currency: "USD",
      targetDate: opts.tripGoal?.targetDate,
      contributionPerCycleOverride: undefined,
      pinnedContribution: null,
      priority: 3,
      paused: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    goals.push(tripGoal);

    const setAsideMinor = opts.tripGoal?.setAsideMinor ?? 0;
    if (setAsideMinor > 0) {
      // Already set aside: a balance-neutral self-transfer on the cash
      // account carrying the goalId, so the engine counts it as earmarked.
      const setAsideAccount =
        accounts.find((a) => a.id === cash.id) ?? accounts.find((a) => a.countsAsSpendable);
      if (setAsideAccount) {
        transactions.push({
          id: crypto.randomUUID(),
          type: "Transfer",
          amount: setAsideMinor,
          currency: "USD",
          date: migrationDate,
          accountId: setAsideAccount.id,
          transferToAccountId: setAsideAccount.id,
          categoryId: null,
          payee: "Already set aside for LA trip",
          status: "Cleared",
          notes: "Already set aside for LA trip",
          tags: [],
          goalId: tripGoal.id,
          createdAt: nowIso,
          updatedAt: nowIso,
        });
      }
    }
  }

  // 9. Primary payday rule (semi-monthly)
  const days = [v1.settings.payday_one ?? 15, v1.settings.payday_two ?? 30]
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 31)
    .sort((a, b) => a - b);
  const paydayDays = days.length > 0 ? days : [15, 30];
  const nextPayday = (() => {
    const candidates = paydayDays.map((d) => nextDomOnOrAfter(migrationDate, d));
    candidates.sort();
    return candidates[0] as DateOnly;
  })();
  mkRule({
    kind: "Income",
    name: "Paycheck",
    amount: dollarsToMinor(v1.settings.paycheck_amount ?? 0),
    currency: "USD",
    accountId: cash.id,
    categoryId: ensureCategory("Income", "income").id,
    frequency: "semi-monthly",
    daysOfMonth: paydayDays,
    nextDueDate: nextPayday,
    weekendShift: "previous-business-day",
    autoPay: false,
    reminderOffsetDays: 3,
    isPrimaryPayday: true,
    skippedDates: [],
    active: true,
  });

  return { accounts, categories, transactions, recurringRules, goals, splits: [], warnings };
}

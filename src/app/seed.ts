/**
 * Demo dataset. Phase 1 decision 5: sample data lives in a SEPARATE Dexie
 * database ("money-tracker-demo") that can be wiped in one tap and never
 * mixes with real data. Seeding happens only from an explicit "Load demo"
 * tap (or onboarding) — never automatically on app load, so wiping the
 * demo can never appear to do nothing. Shaped like Malike's real
 * situation: semi-monthly $2,263.41 paychecks, his actual bills, and his
 * three goals in priority order.
 */
import { getDemoDb, isDemoMode, setDemoMode } from "../data/db.js";
import { createRepositories } from "../data/repositories/index.js";
import type { Account } from "../domain/entities/account.js";
import type { Category } from "../domain/entities/category.js";
import type { Transaction } from "../domain/entities/transaction.js";
import type { Goal } from "../domain/entities/goal.js";
import type { RecurringRule } from "../domain/entities/recurringRule.js";
import type { Split } from "../domain/entities/split.js";

const now = () => new Date().toISOString();

export { isDemoMode };

const C = (
  id: string,
  name: string,
  kind: Category["kind"],
  icon: string,
  color: string,
): Category => ({ id, name, kind, icon, color, archived: false });

const A = (
  id: string,
  name: string,
  type: Account["type"],
  startingBalance: number,
  countsAsSpendable: boolean,
): Account => ({
  id,
  name,
  type,
  currency: "USD",
  startingBalance,
  startingDate: "2026-10-01",
  countsAsSpendable,
  archived: false,
  createdAt: now(),
  updatedAt: now(),
});

const T = (
  id: string,
  type: Transaction["type"],
  amount: number,
  date: string,
  accountId: string,
  categoryId: string | null,
  payee: string,
  status: Transaction["status"],
  extra?: Partial<Transaction>,
): Transaction => ({
  id,
  type,
  amount,
  currency: "USD",
  date,
  accountId,
  categoryId,
  payee,
  status,
  notes: "",
  tags: [],
  createdAt: now(),
  updatedAt: now(),
  ...extra,
});

const R = (
  id: string,
  kind: RecurringRule["kind"],
  name: string,
  amount: number,
  accountId: string,
  categoryId: string,
  frequency: RecurringRule["frequency"],
  nextDueDate: string,
  extra?: Partial<RecurringRule>,
): RecurringRule => ({
  id,
  kind,
  name,
  amount,
  currency: "USD",
  accountId,
  categoryId,
  frequency,
  nextDueDate,
  weekendShift: "none",
  autoPay: false,
  reminderOffsetDays: 3,
  skippedDates: [],
  active: true,
  createdAt: now(),
  updatedAt: now(),
  ...extra,
});

/** Write the demo dataset into the demo database. Assumes it is empty. */
export async function seedDemoData(): Promise<void> {
  const repos = createRepositories(getDemoDb());
  const categories: Category[] = [
    C("cat-income", "Income", "income", "arrow-down-circle", "emerald"),
    C("cat-housing", "Housing", "expense", "home", "blue"),
    C("cat-utilities", "Utilities", "expense", "plug", "amber"),
    C("cat-food", "Food", "expense", "utensils", "emerald"),
    C("cat-coffee", "Coffee", "expense", "coffee", "amber"),
    C("cat-transit", "Transit", "expense", "train", "blue"),
    C("cat-groceries", "Groceries", "expense", "bag", "violet"),
    C("cat-transfer", "Transfer", "expense", "arrow-left-right", "slate"),
    C("cat-other", "Other", "expense", "dots", "slate"),
  ];

  const accounts: Account[] = [
    A("acct-checking", "Checking", "Checking", 310000, true),
    A("acct-cash", "Cash", "Cash", 1300, true),
    A("acct-savings", "Savings", "Savings", 225000, false),
    A("acct-creditone", "Credit One", "CreditCard", -40000, false),
    A("acct-aspire", "Aspire", "CreditCard", -48560, false),
  ];

  const rules: RecurringRule[] = [
    R("rule-paycheck", "Income", "Paycheck", 226341, "acct-checking", "cat-income", "semi-monthly", "2026-10-15", {
      daysOfMonth: [15, 30],
      weekendShift: "previous-business-day",
      isPrimaryPayday: true,
      lastGeneratedThrough: "2026-09-30",
    }),
    R("rule-rent", "Bill", "Rent", 135000, "acct-checking", "cat-housing", "monthly", "2026-11-01", {
      autoPay: true,
      lastGeneratedThrough: "2026-10-01",
    }),
    R("rule-internet", "Bill", "Internet", 6200, "acct-checking", "cat-utilities", "monthly", "2026-10-10", {
      lastGeneratedThrough: "2026-09-10",
    }),
    R("rule-phone", "Bill", "Phone", 11000, "acct-checking", "cat-utilities", "monthly", "2026-11-05", {
      lastGeneratedThrough: "2026-10-05",
    }),
    R("rule-concord", "Bill", "Concord", 26400, "acct-checking", "cat-other", "monthly", "2026-11-11", {
      lastGeneratedThrough: "2026-10-11",
    }),
    R("rule-creditone-min", "Bill", "Credit One minimum", 4700, "acct-checking", "cat-other", "monthly", "2026-11-03", {
      lastGeneratedThrough: "2026-10-03",
    }),
    R("rule-aspire-min", "Bill", "Aspire minimum", 32191, "acct-checking", "cat-other", "monthly", "2026-10-28", {
      lastGeneratedThrough: "2026-09-28",
    }),
  ];

  const transactions: Transaction[] = [
    // Prior-cycle savings funding (Sep 30): not part of this cycle's commitment.
    T("tx-sep30-save", "Transfer", 15000, "2026-09-30", "acct-checking", null, "Emergency fund", "Cleared", {
      transferToAccountId: "acct-savings",
      goalId: "goal-emergency",
    }),
    T("tx-oct1-rent", "Expense", 135000, "2026-10-01", "acct-checking", "cat-housing", "Rent", "Cleared"),
    T("tx-oct3-groc", "Expense", 4500, "2026-10-03", "acct-creditone", "cat-groceries", "Grocery run", "Cleared"),
    T("tx-oct5-phone", "Expense", 11000, "2026-10-05", "acct-checking", "cat-utilities", "Phone", "Cleared"),
    T("tx-oct8-wholefoods", "Expense", 6240, "2026-10-08", "acct-checking", "cat-food", "Whole Foods", "Pending"),
    T("tx-oct10-gas", "Expense", 3250, "2026-10-10", "acct-creditone", "cat-transit", "Gas", "Cleared"),
    T("tx-oct11-concord", "Expense", 26400, "2026-10-11", "acct-checking", "cat-other", "Concord", "Cleared"),
    // Oct 14, from the real Amex screenshot.
    T("tx-oct14-1", "Expense", 300, "2026-10-14", "acct-checking", "cat-transit", "NYCT PAYGO", "Cleared"),
    T("tx-oct14-2", "Expense", 416, "2026-10-14", "acct-checking", "cat-food", "Mario Gourmet Deli", "Cleared"),
    T("tx-oct14-3", "Expense", 876, "2026-10-14", "acct-checking", "cat-coffee", "Gregorys Coffee", "Cleared"),
    T("tx-oct14-4", "Expense", 300, "2026-10-14", "acct-checking", "cat-transit", "NYCT PAYGO", "Cleared"),
    T("tx-oct14-5", "Expense", 300, "2026-10-14", "acct-checking", "cat-transit", "NYCT PAYGO", "Cleared"),
    T("tx-oct14-6", "Expense", 1634, "2026-10-14", "acct-checking", "cat-food", "Kotti Berliner Doner Kebab", "Cleared"),
    T("tx-oct14-7", "Expense", 1399, "2026-10-14", "acct-checking", "cat-other", "Chelsea Corner Grocery", "Cleared"),
    // Payday confirmed this morning. Catch-up dedupes on (rule, occurrenceDate).
    T("tx-oct15-pay", "Income", 226341, "2026-10-15", "acct-checking", "cat-income", "Paycheck", "Cleared", {
      recurringRuleId: "rule-paycheck",
      occurrenceDate: "2026-10-15",
    }),
    T("tx-oct15-coffee", "Expense", 876, "2026-10-15", "acct-checking", "cat-coffee", "Gregorys Coffee", "Pending"),
  ];

  const goals: Goal[] = [
    {
      id: "goal-debt",
      name: "Extra debt payoff",
      targetAmount: 47750,
      currency: "USD",
      targetDate: "2026-12-31",
      pinnedContribution: null,
      priority: 1,
      paused: false,
      createdAt: now(),
      updatedAt: now(),
    },
    {
      id: "goal-emergency",
      name: "Emergency fund",
      targetAmount: 1000000,
      currency: "USD",
      targetDate: "2027-07-31",
      linkedSavingsAccountId: "acct-savings",
      contributionPerCycleOverride: 15000,
      pinnedContribution: null,
      priority: 2,
      paused: false,
      createdAt: now(),
      updatedAt: now(),
    },
    {
      id: "goal-la",
      name: "LA trip float",
      targetAmount: 57000,
      currency: "USD",
      targetDate: "2026-10-22",
      contributionPerCycleOverride: 57000,
      pinnedContribution: null,
      priority: 3,
      paused: false,
      createdAt: now(),
      updatedAt: now(),
    },
  ];

  const splits: Split[] = [
    {
      id: "split-cassius",
      linkedTransactionId: "tx-oct14-6",
      person: "Cassius",
      amount: 5000,
      currency: "USD",
      direction: "TheyOweMe",
      settled: false,
      countOnIt: false,
      createdAt: "2026-09-20T12:00:00.000Z",
    },
  ];

  await repos.categories.putMany(categories);
  await repos.accounts.putMany(accounts);
  await repos.recurringRules.putMany(rules);
  await repos.transactions.putMany(transactions);
  await repos.goals.putMany(goals);
  await repos.splits.putMany(splits);
  await repos.settings.save({
    id: "settings",
    baseCurrency: "USD",
    bufferAmount: 0,
    theme: "system",
    notificationsEnabled: false,
    onboardingCompleted: false,
  });
  setDemoMode(true);
}

/**
 * Explicit "Load demo" action: wipes any existing demo data, re-seeds,
 * and switches the app to the demo database.
 */
export async function loadDemoData(): Promise<void> {
  await wipeDemoData();
  await seedDemoData();
}

/**
 * One-tap wipe of the demo dataset. Clears every table in the DEMO
 * database only and switches the app back to the real database.
 * Real user data is never touched.
 */
export async function wipeDemoData(): Promise<void> {
  const db = getDemoDb();
  await db.transaction(
    "rw",
    [
      db.accounts,
      db.categories,
      db.transactions,
      db.recurringRules,
      db.recurringOverrides,
      db.goals,
      db.splits,
      db.settings,
      db.paydayRuns,
      db.dailySnapshots,
    ],
    async () => {
      await Promise.all([
        db.accounts.clear(),
        db.categories.clear(),
        db.transactions.clear(),
        db.recurringRules.clear(),
        db.recurringOverrides.clear(),
        db.goals.clear(),
        db.splits.clear(),
        db.settings.clear(),
        db.paydayRuns.clear(),
        db.dailySnapshots.clear(),
      ]);
    },
  );
  setDemoMode(false);
}

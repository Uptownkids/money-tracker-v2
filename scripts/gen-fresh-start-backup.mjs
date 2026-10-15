/**
 * Generates a fresh-start backup JSON for Malike (2026-10-15).
 * Starting balances as of 2026-10-15; today's spending is already
 * reflected in them, so no transactions are added for today.
 * The LLC $203 and Google Workspace $8.24 are recorded as history-only
 * rows dated 2026-10-14 (before the accounts' startingDate), so the
 * balance engines ignore them while history/Insights keep them.
 */
import { writeFileSync } from "node:fs";

const NOW = new Date().toISOString();
const START = "2026-10-15"; // startingDate for every account
const HIST = "2026-10-14"; // history-only rows: before tracking started
const USD = "USD";
const C = (d) => Math.round(d * 100); // dollars -> cents

const now = () => NOW;

function account(id, name, type, startingBalance, countsAsSpendable) {
  return {
    id, name, type, currency: USD,
    startingBalance, startingDate: START,
    countsAsSpendable, archived: false,
    createdAt: now(), updatedAt: now(),
  };
}

const accounts = [
  // Wells Fargo checking $1,721.20 as of today, from his bank app.
  // This is where all spending happens (paycheck arrives via
  // Amex savings -> Amex checking -> Zelle). Only spendable account.
  account("acct-checking", "Wells Fargo Checking", "Checking", C(1721.2), true),
  // Amex online savings: the paycheck lands here first, and the $10k
  // savings goal lives here. Starting at $0 (to confirm).
  account("acct-amex-savings", "Amex Savings", "Savings", C(0), false),
  // Liabilities are stored negative (toStoredBalance semantics).
  account("acct-credit-one", "Credit One", "CreditCard", -C(997.35), false),
  account("acct-concord", "Concord", "Loan", -C(1583.85), false),
];

function category(id, name, kind, icon, color) {
  return { id, name, kind, icon, color, archived: false };
}

const categories = [
  category("cat-food", "Food", "expense", "utensils", "emerald"),
  category("cat-housing", "Housing", "expense", "home", "blue"),
  category("cat-transit", "Transit", "expense", "train", "blue"),
  category("cat-entertainment", "Entertainment", "expense", "ticket", "violet"),
  category("cat-utilities", "Utilities", "expense", "plug", "amber"),
  category("cat-health", "Health", "expense", "heart", "rose"),
  category("cat-shopping", "Shopping", "expense", "bag", "violet"),
  category("cat-coffee", "Coffee", "expense", "coffee", "amber"),
  category("cat-business", "Business", "expense", "briefcase", "slate"),
  category("cat-income", "Income", "income", "arrow-down-circle", "emerald"),
  category("cat-transfer", "Transfer", "expense", "arrow-left-right", "slate"),
  category("cat-other", "Other", "expense", "dots", "slate"),
];

function txn(id, type, amount, date, accountId, categoryId, payee, status, extra = {}) {
  return {
    id, type, amount, currency: USD, date, accountId, categoryId,
    payee, status, notes: "", tags: [],
    createdAt: now(), updatedAt: now(), ...extra,
  };
}

const HISTORY_NOTE =
  "Paid 2026-10-15; recorded as history only (already reflected in the starting balance).";

const transactions = [
  txn("txn-llc-2026-10-15", "Expense", C(203), HIST, "acct-checking", "cat-business",
    "LLC filing", "Cleared",
    { tags: ["Business"], notes: HISTORY_NOTE }),
  txn("txn-gws-2026-10-15", "Expense", C(8.24), HIST, "acct-checking", "cat-business",
    "Google Workspace", "Cleared",
    { tags: ["Business"], notes: HISTORY_NOTE }),
  // Today's spending, logged as history only (already in the $1,721.20).
  txn("txn-citibike-2026-10-15", "Expense", C(0.88), HIST, "acct-checking", "cat-transit",
    "Citi Bike", "Cleared",
    { notes: "Spent 2026-10-15; recorded as history only (already reflected in the starting balance)." }),
  txn("txn-coffee-2026-10-15", "Expense", C(8.76), HIST, "acct-checking", "cat-coffee",
    "Coffee", "Cleared",
    { notes: "Spent 2026-10-15; recorded as history only (already reflected in the starting balance)." }),
  // LA trip float: $570 earmarked inside checking. Balance-neutral
  // self-transfer, so the goal shows funded without moving the balance.
  txn("txn-la-float-setaside", "Transfer", C(570), START, "acct-checking", null,
    "LA trip float set-aside", "Cleared",
    {
      transferToAccountId: "acct-checking",
      goalId: "goal-la-float",
      notes: "Earmarked within Wells Fargo checking for the Oct 22 LA trip.",
    }),
];

function rule(id, kind, name, amount, accountId, categoryId, frequency, nextDueDate, extra = {}) {
  return {
    id, kind, name, amount, currency: USD, accountId, categoryId,
    frequency, nextDueDate, weekendShift: "none",
    autoPay: false, reminderOffsetDays: 3,
    skippedDates: [], active: true,
    createdAt: now(), updatedAt: now(), ...extra,
  };
}

const recurringRules = [
  // Paycheck $2,263.41 on the 15th and 30th. In reality it lands in Amex
  // savings, then moves Amex checking -> Zelle -> Wells Fargo checking.
  // The rule books the net effect (into Wells Fargo) to keep payday
  // friction at zero. Today's is already received and inside the
  // checking balance, so the next occurrence is Oct 30.
  rule("rule-paycheck", "Income", "Paycheck", C(2263.41), "acct-checking", "cat-income",
    "semi-monthly", "2026-10-30",
    { daysOfMonth: [15, 30], isPrimaryPayday: true, weekendShift: "previous-business-day" }),
  // Credit One: $97 minimum, due on the 8th, paid from checking.
  // Debt-payment rule -> generates Transfers to the card, never Expenses.
  rule("rule-credit-one-min", "Bill", "Credit One minimum", C(97), "acct-checking", "cat-transfer",
    "monthly", "2026-11-08",
    { payToAccountId: "acct-credit-one", isCreditCardPayment: true }),
  // Concord: $343 minimum, due on the 11th, paid from checking.
  rule("rule-concord-min", "Bill", "Concord minimum", C(343), "acct-checking", "cat-transfer",
    "monthly", "2026-11-11",
    { payToAccountId: "acct-concord" }),
  // Google Workspace: $8.24/mo subscription, due on the 15th, Business.
  rule("rule-google-workspace", "Subscription", "Google Workspace", C(8.24),
    "acct-checking", "cat-business", "monthly", "2026-11-15", {}),
];

function goal(id, name, targetAmount, priority, extra = {}) {
  return {
    id, name, targetAmount, currency: USD,
    pinnedContribution: null, priority, paused: false, completed: false,
    createdAt: now(), updatedAt: now(), ...extra,
  };
}

const goals = [
  goal("goal-savings-10k", "Savings", C(10000), 2, {
    linkedSavingsAccountId: "acct-amex-savings",
    // Malike's set amount: $150 per paycheck until the Nikon invoice
    // lands (then ~$400). Overrides the default 1-year-horizon math.
    contributionPerCycleOverride: C(150),
  }),
  // LA trip float: $570 set aside from the $1,721.20 checking balance
  // (see the set-aside self-transfer above).
  goal("goal-la-float", "LA trip float", C(570), 3, { targetDate: "2026-10-22" }),
];

const settings = [
  {
    id: "settings", baseCurrency: "USD", bufferAmount: 0,
    theme: "system", notificationsEnabled: false,
    onboardingCompleted: true, lastBackupAt: NOW,
  },
];

const backup = {
  version: 1,
  exportedAt: NOW,
  tables: {
    accounts, categories, transactions, recurringRules,
    recurringOverrides: [], goals, splits: [], settings,
    paydayRuns: [], dailySnapshots: [], snoozedMoves: [],
  },
};

const out = "/home/hatch/workspace/your_files/money-tracker-fresh-start-2026-10-15.json";
writeFileSync(out, JSON.stringify(backup, null, 2) + "\n");
console.log("wrote", out);

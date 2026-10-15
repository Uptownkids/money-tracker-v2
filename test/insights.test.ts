import { describe, expect, it } from "vitest";
import {
  goalProgress,
  incomeVsOutflow,
  monthlyCashFlow,
  outstandingIous,
  runway,
  shiftMonthKey,
  spendingByCategory,
  spendingHistory,
  subscriptionTotals,
} from "../src/domain/engine/insights.js";
import { mkAccount, mkCategory, mkGoal, mkRule, mkSplit, mkTransaction } from "./helpers.js";
import type { Transaction } from "../src/domain/entities/transaction.js";
import type { DateOnly } from "../src/domain/dates/dateOnly.js";
import type { DailySnapshot } from "../src/domain/entities/settings.js";

const OCT = "2026-10";
const tx = (o: Partial<Transaction>) => mkTransaction(o);

describe("monthlyCashFlow", () => {
  it("nets refunds against expenses, never against income", () => {
    const txs = [
      tx({ type: "Income", amount: 500000, date: "2026-10-01" }),
      tx({ type: "Expense", amount: 120000, date: "2026-10-05", categoryId: "c1" }),
      tx({ type: "Refund", amount: 20000, date: "2026-10-06", refundOfTransactionId: "e1" }),
    ];
    const cf = monthlyCashFlow(txs, OCT);
    expect(cf.income).toBe(500000);
    expect(cf.expenses).toBe(100000); // 120000 - 20000
    expect(cf.net).toBe(400000);
  });

  it("excludes ALL transfers, including debt-payment transfers", () => {
    const txs = [
      tx({ type: "Transfer", amount: 90000, date: "2026-10-10", transferToAccountId: "card-1" }),
      tx({ type: "Transfer", amount: 50000, date: "2026-10-11", accountId: "chk", transferToAccountId: "chk" }),
      tx({ type: "Income", amount: 100000, date: "2026-10-01" }),
    ];
    const cf = monthlyCashFlow(txs, OCT);
    expect(cf.income).toBe(100000);
    expect(cf.expenses).toBe(0);
    expect(cf.net).toBe(100000);
  });

  it("excludes Income rows carrying a splitId (IOU settlements are not earned income)", () => {
    const txs = [
      tx({ type: "Income", amount: 100000, date: "2026-10-01" }),
      tx({ type: "Income", amount: 30000, date: "2026-10-02", splitId: "s-1" }),
    ];
    expect(monthlyCashFlow(txs, OCT).income).toBe(100000);
  });

  it("excludes Scheduled rows and rows from other months", () => {
    const txs = [
      tx({ type: "Expense", amount: 50000, date: "2026-10-05", status: "Scheduled" }),
      tx({ type: "Expense", amount: 70000, date: "2026-09-30" }),
      tx({ type: "Expense", amount: 25000, date: "2026-10-20", status: "Pending" }),
    ];
    expect(monthlyCashFlow(txs, OCT).expenses).toBe(25000);
  });
});

describe("spendingByCategory", () => {
  const food = mkCategory({ id: "food", name: "Food" });
  const fun = mkCategory({ id: "fun", name: "Fun" });

  it("nets a linked refund against its expense category", () => {
    const expense = tx({ id: "e1", type: "Expense", amount: 8000, date: "2026-10-03", categoryId: "food" });
    const txs = [
      expense,
      tx({ type: "Refund", amount: 3000, date: "2026-10-04", refundOfTransactionId: "e1" }),
    ];
    const rows = spendingByCategory(txs, OCT, [food, fun]);
    expect(rows).toEqual([{ categoryId: "food", name: "Food", amount: 5000 }]);
  });

  it("puts an unlinked refund in the Uncategorized bucket", () => {
    const txs = [
      tx({ type: "Expense", amount: 4000, date: "2026-10-03", categoryId: "fun" }),
      tx({ type: "Refund", amount: 1000, date: "2026-10-04" }),
    ];
    const rows = spendingByCategory(txs, OCT, [food, fun]);
    expect(rows).toEqual([
      { categoryId: "fun", name: "Fun", amount: 4000 },
      { categoryId: null, name: "Uncategorized", amount: -1000 },
    ]);
  });

  it("sorts descending and drops zero-net buckets", () => {
    const expense = tx({ id: "e2", type: "Expense", amount: 2000, date: "2026-10-03", categoryId: "food" });
    const txs = [
      tx({ type: "Expense", amount: 9000, date: "2026-10-01", categoryId: "fun" }),
      expense,
      tx({ type: "Refund", amount: 2000, date: "2026-10-02", refundOfTransactionId: "e2" }),
      tx({ type: "Expense", amount: 3000, date: "2026-10-01", categoryId: null }),
    ];
    const rows = spendingByCategory(txs, OCT, [food, fun]);
    // food nets to 0 and is dropped; fun first, then uncategorized
    expect(rows.map((r) => r.name)).toEqual(["Fun", "Uncategorized"]);
    expect(rows[0]!.amount).toBe(9000);
    expect(rows[1]!.amount).toBe(3000);
  });
});

describe("incomeVsOutflow", () => {
  it("returns 12 buckets ending at endMonth, oldest first", () => {
    const buckets = incomeVsOutflow([], "2026-10", 12);
    expect(buckets).toHaveLength(12);
    expect(buckets[0]!.month).toBe("2025-11");
    expect(buckets[11]!.month).toBe("2026-10");
  });

  it("buckets income and outflow by month", () => {
    const txs = [
      tx({ type: "Income", amount: 100000, date: "2026-08-01" }),
      tx({ type: "Expense", amount: 40000, date: "2026-08-15" }),
      tx({ type: "Income", amount: 100000, date: "2026-09-01" }),
      tx({ type: "Expense", amount: 60000, date: "2026-09-15" }),
      tx({ type: "Refund", amount: 10000, date: "2026-09-20" }),
    ];
    const buckets = incomeVsOutflow(txs, "2026-09", 3);
    expect(buckets.map((b) => b.month)).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(buckets[1]).toEqual({ month: "2026-08", income: 100000, outflow: 40000 });
    expect(buckets[2]).toEqual({ month: "2026-09", income: 100000, outflow: 50000 });
    expect(buckets[0]).toEqual({ month: "2026-07", income: 0, outflow: 0 });
  });
});

describe("shiftMonthKey", () => {
  it("handles year boundaries", () => {
    expect(shiftMonthKey("2026-01", -1)).toBe("2025-12");
    expect(shiftMonthKey("2025-12", 1)).toBe("2026-01");
    expect(shiftMonthKey("2026-10", 0)).toBe("2026-10");
  });
});

describe("runway", () => {
  const checking = mkAccount({ id: "chk", countsAsSpendable: true, currency: "USD" });
  const savings = mkAccount({ id: "sav", type: "Savings", countsAsSpendable: false, currency: "USD" });
  const balances = { chk: 90000, sav: 50000 };

  it("computes liquid from spendable accounts and floors whole days", () => {
    const txs = [
      // $30/day over the trailing 30 days -> avg 3000/day
      tx({ type: "Expense", amount: 3000, date: "2026-10-15" }),
      tx({ type: "Expense", amount: 3000, date: "2026-10-01" }),
      tx({ type: "Expense", amount: 3000, date: "2026-09-16" }),
      // outside the window: ignored
      tx({ type: "Expense", amount: 3000, date: "2026-09-15" }),
      // refund nets down the trailing total
      tx({ type: "Refund", amount: 3000, date: "2026-10-10" }),
    ];
    // trailing = 9000 - 3000 = 6000 over 30 days -> 200/day; liquid 90000 -> 450 days
    const r = runway([checking, savings], balances, txs, "2026-10-15");
    expect(r.liquid).toBe(90000);
    expect(r.avgDailySpending).toBe(200);
    expect(r.days).toBe(450);
  });

  it("excludes Scheduled rows and Transfers from trailing spending", () => {
    const txs = [
      tx({ type: "Expense", amount: 30000, date: "2026-10-15", status: "Scheduled" }),
      tx({ type: "Transfer", amount: 30000, date: "2026-10-15", transferToAccountId: "sav" }),
    ];
    const r = runway([checking], { chk: 10000 }, txs, "2026-10-15");
    expect(r.avgDailySpending).toBe(0);
    expect(r.days).toBeNull();
  });

  it("returns null days with no spending yet", () => {
    const r = runway([checking], { chk: 50000 }, [], "2026-10-15");
    expect(r.liquid).toBe(50000);
    expect(r.days).toBeNull();
  });
});

describe("spendingHistory", () => {
  const toBase = (t: Transaction) => t.amount;
  const snap = (date: string, available: number, committed: number, daysLeft: number): DailySnapshot => ({
    id: date,
    date: date as DateOnly,
    startOfDayAmount: 0,
    available,
    committed,
    daysLeft,
    createdAt: "2026-10-15T00:00:00.000Z",
  });

  it("classifies spent == budget as under and mirrors the daily formula", () => {
    // budget = floor((10000 - 4000) / 3) = 2000, whole-unit rounded
    const snapshots = [snap("2026-10-13", 10000, 4000, 3), snap("2026-10-14", 10000, 4000, 3)];
    const txs = [
      tx({ type: "Expense", amount: 2000, date: "2026-10-13" }), // == budget -> under
      tx({ type: "Expense", amount: 2001, date: "2026-10-14" }), // over
    ];
    const h = spendingHistory(snapshots, txs, toBase, "USD");
    expect(h.days.map((d) => d.status)).toEqual(["under", "over"]);
    expect(h.under).toBe(1);
    expect(h.over).toBe(1);
    expect(h.days[0]!.budget).toBe(2000);
  });

  it("rounds the budget down to whole currency units like the app", () => {
    // floor(9999 / 4) = 2499 -> $24.99
    const snapshots = [snap("2026-10-13", 9999, 0, 4)];
    const h = spendingHistory(snapshots, [], toBase, "USD");
    expect(h.days[0]!.budget).toBe(2400);
  });

  it("never lets the budget go negative", () => {
    const snapshots = [snap("2026-10-13", 1000, 9000, 5)];
    const h = spendingHistory(snapshots, [], toBase, "USD");
    expect(h.days[0]!.budget).toBe(0);
    expect(h.days[0]!.status).toBe("under");
  });
});

describe("goalProgress", () => {
  it("clamps pct to 0..100 and handles a zero target", () => {
    const goals = [
      mkGoal({ id: "g1", targetAmount: 10000 }),
      mkGoal({ id: "g2", targetAmount: 10000 }),
      mkGoal({ id: "g3", targetAmount: 0 }),
    ];
    const txs = [
      tx({ type: "Transfer", amount: 12000, goalId: "g1", transferToAccountId: "sav" }),
      tx({ type: "Expense", amount: 2000, goalId: "g2" }),
      tx({ type: "Transfer", amount: 5000, goalId: "g3", transferToAccountId: "sav" }),
    ];
    const rows = goalProgress(goals, txs);
    expect(rows[0]!.saved).toBe(12000);
    expect(rows[0]!.pct).toBe(100); // clamped, not 120
    expect(rows[1]!.saved).toBe(-2000);
    expect(rows[1]!.pct).toBe(0); // floored, not negative
    expect(rows[2]!.pct).toBe(0); // zero target
  });
});

describe("outstandingIous", () => {
  it("splits unsettled IOUs by direction and ignores settled ones", () => {
    const splits = [
      mkSplit({ direction: "TheyOweMe", amount: 5000, settled: false }),
      mkSplit({ direction: "TheyOweMe", amount: 3000, settled: true }),
      mkSplit({ direction: "IOweThem", amount: 2000, settled: false }),
      mkSplit({ direction: "IOweThem", amount: 1000, settled: false, countOnIt: true }),
    ];
    const out = outstandingIous(splits);
    expect(out.owedToYou).toBe(5000);
    expect(out.youOwe).toBe(3000);
  });
});

describe("subscriptionTotals", () => {
  it("sums annualCost over active Subscription rules only", () => {
    const rules = [
      mkRule({ kind: "Subscription", name: "Music", amount: 1099, frequency: "monthly", nextDueDate: "2026-10-20", active: true }),
      mkRule({ kind: "Subscription", name: "Old", amount: 9999, frequency: "monthly", nextDueDate: "2026-10-20", active: false }),
      mkRule({ kind: "Bill", name: "Rent", amount: 135000, frequency: "monthly", nextDueDate: "2026-11-01", active: true }),
    ];
    const t = subscriptionTotals(rules, [], "2026-10-15");
    expect(t.perYear).toBe(1099 * 12);
    expect(t.perMonth).toBe(1099);
  });

  it("rounds perMonth from a yearly rule", () => {
    const rules = [
      mkRule({ kind: "Subscription", name: "Yearly", amount: 10000, frequency: "annual", nextDueDate: "2027-03-01", active: true }),
    ];
    const t = subscriptionTotals(rules, [], "2026-10-15");
    expect(t.perYear).toBe(10000);
    expect(t.perMonth).toBe(Math.round(10000 / 12));
  });
});

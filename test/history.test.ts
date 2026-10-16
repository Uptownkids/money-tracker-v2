/**
 * Spending history tests (Phase B3): totals from the ledger, transfers
 * excluded, refunds netted, business filter, YoY, subscriptions.
 */
import { describe, expect, it } from "vitest";
import {
  buildSpendingHistory,
  monthlyCostFor,
} from "../src/domain/engine/history.js";
import type { Category } from "../src/domain/entities/category.js";
import type { RecurringRule } from "../src/domain/entities/recurringRule.js";
import type { Transaction } from "../src/domain/entities/transaction.js";
import { mkCategory, mkRule, mkTransaction } from "./helpers.js";

const CATS: Category[] = [
  mkCategory({ id: "cat-coffee", name: "Coffee", kind: "expense" }),
  mkCategory({ id: "cat-music", name: "Music", kind: "expense" }),
];

function tx(over: Partial<Transaction>): Transaction {
  return mkTransaction({
    id: `tx-${Math.random().toString(36).slice(2)}`,
    accountId: "acct-checking",
    date: "2026-10-15",
    amount: 100,
    payee: "Test",
    categoryId: "cat-coffee",
    status: "Cleared",
    ...over,
  } as never);
}

describe("buildSpendingHistory", () => {
  it("totals expenses by year and month", () => {
    const h = buildSpendingHistory(
      [tx({ date: "2026-10-15", amount: 500 }), tx({ date: "2026-09-10", amount: 300 })],
      [],
      CATS,
      { includeBusiness: true },
      "2026-10-16" as never,
    );
    expect(h.years).toHaveLength(1);
    expect(h.years[0]?.total).toBe(800);
    expect(h.years[0]?.months).toHaveLength(2);
    expect(h.years[0]?.months[0]?.month).toBe("2026-09");
  });

  it("excludes transfers and income, nets refunds", () => {
    const h = buildSpendingHistory(
      [
        tx({ type: "Expense", amount: 1000 }),
        tx({ type: "Transfer", amount: 5000, transferToAccountId: "acct-x", categoryId: null }),
        tx({ type: "Income", amount: 2000, categoryId: "cat-income" }),
        tx({ type: "Refund", amount: 200, categoryId: "cat-coffee" }),
      ],
      [],
      CATS,
      { includeBusiness: true },
      "2026-10-16" as never,
    );
    expect(h.years[0]?.total).toBe(800); // 1000 - 200
    const coffee = h.years[0]?.byCategory.find((c) => c.categoryId === "cat-coffee");
    expect(coffee?.total).toBe(800);
  });

  it("excludes Expenses filed under a Transfer category", () => {
    const cats: Category[] = [
      ...CATS,
      mkCategory({ id: "cat-transfer", name: "Transfer", kind: "expense" }),
    ];
    const h = buildSpendingHistory(
      [
        tx({ type: "Expense", amount: 1000 }),
        tx({ type: "Expense", amount: 5000, categoryId: "cat-transfer" }),
      ],
      [],
      cats,
      { includeBusiness: true },
      "2026-10-16" as never,
    );
    expect(h.years[0]?.total).toBe(1000);
    expect(h.years[0]?.byCategory.some((c) => c.name === "Transfer")).toBe(false);
  });

  it("excludes business spending when asked", () => {
    const h = buildSpendingHistory(
      [
        tx({ amount: 1000 }),
        tx({ amount: 20300, payee: "LLC filing", tags: ["business"] }),
      ],
      [],
      CATS,
      { includeBusiness: false },
      "2026-10-16" as never,
    );
    expect(h.years[0]?.total).toBe(1000);
    const withBiz = buildSpendingHistory(
      [
        tx({ amount: 1000 }),
        tx({ amount: 20300, payee: "LLC filing", tags: ["business"] }),
      ],
      [],
      CATS,
      { includeBusiness: true },
      "2026-10-16" as never,
    );
    expect(withBiz.years[0]?.total).toBe(21300);
  });

  it("splits bills/subscriptions from everything else", () => {
    const rule = mkRule({
      id: "rule-spotify",
      kind: "Subscription",
      name: "Spotify",
      amount: 1299,
      accountId: "acct-checking",
      nextDueDate: "2026-11-15" as never,
    });
    const h = buildSpendingHistory(
      [
        tx({ amount: 1299, payee: "Spotify", categoryId: "cat-music", recurringRuleId: "rule-spotify" }),
        tx({ amount: 500, payee: "Coffee" }),
      ],
      [rule],
      CATS,
      { includeBusiness: true },
      "2026-10-16" as never,
    );
    const oct = h.years[0]?.months[0];
    expect(oct?.bills).toBe(1299);
    expect(oct?.everythingElse).toBe(500);
  });

  it("groups by merchant", () => {
    const h = buildSpendingHistory(
      [
        tx({ amount: 450, payee: "Starbucks" }),
        tx({ amount: 500, payee: "STARBUCKS" }),
        tx({ amount: 876, payee: "Citi Bike" }),
      ],
      [],
      CATS,
      { includeBusiness: true },
      "2026-10-16" as never,
    );
    const merchants = h.years[0]?.months[0]?.byMerchant ?? [];
    const sbux = merchants.find((m) => m.merchantKey === "STARBUCKS");
    expect(sbux?.total).toBe(950);
    expect(sbux?.transactionIds).toHaveLength(2);
  });

  it("compares year over year per category", () => {
    const h = buildSpendingHistory(
      [
        tx({ date: "2026-05-01", amount: 1200, categoryId: "cat-coffee" }),
        tx({ date: "2025-05-01", amount: 800, categoryId: "cat-coffee" }),
      ],
      [],
      CATS,
      { includeBusiness: true },
      "2026-10-16" as never,
    );
    const coffee = h.yoy.find((y) => y.categoryId === "cat-coffee");
    expect(coffee).toMatchObject({ thisYear: 1200, lastYear: 800, delta: 400 });
  });

  it("includes history-only rows (before tracking start)", () => {
    const h = buildSpendingHistory(
      [tx({ date: "2020-03-10", amount: 999 })],
      [],
      CATS,
      { includeBusiness: true },
      "2026-10-16" as never,
    );
    // 2020 rows appear in history even though balances ignore them.
    expect(h.years.some((y) => y.year === "2020")).toBe(true);
    expect(h.years.find((y) => y.year === "2020")?.total).toBe(999);
  });

  it("summarizes subscriptions: monthly, yearly, lifetime", () => {
    const rule = mkRule({
      id: "rule-spotify",
      kind: "Subscription",
      name: "Spotify",
      amount: 1299,
      frequency: "monthly",
      accountId: "acct-checking",
      nextDueDate: "2026-11-15" as never,
    });
    const ended = mkRule({
      id: "rule-old",
      kind: "Subscription",
      name: "Old Service",
      amount: 999,
      frequency: "monthly",
      accountId: "acct-checking",
      active: false,
      nextDueDate: "2025-01-15" as never,
    });
    const h = buildSpendingHistory(
      [
        tx({ date: "2026-08-15", amount: 1299, payee: "Spotify", recurringRuleId: "rule-spotify" }),
        tx({ date: "2026-09-15", amount: 1299, payee: "Spotify", recurringRuleId: "rule-spotify" }),
        tx({ date: "2024-05-01", amount: 999, payee: "Old", recurringRuleId: "rule-old" }),
      ],
      [rule, ended],
      CATS,
      { includeBusiness: true },
      "2026-10-16" as never,
    );
    expect(h.subscriptions).toHaveLength(2);
    const sub = h.subscriptions.find((s) => s.ruleId === "rule-spotify");
    expect(sub).toMatchObject({
      monthlyCost: 1299,
      yearlyCost: 1299 * 12,
      totalSpent: 2598,
      chargeCount: 2,
      active: true,
      since: "2026-08-15",
    });
    const past = h.subscriptions.find((s) => s.ruleId === "rule-old");
    expect(past?.active).toBe(false);
  });

  it("every total carries its transaction ids for drill-down", () => {
    const h = buildSpendingHistory(
      [tx({ id: "a", amount: 500 }), tx({ id: "b", amount: 300 })],
      [],
      CATS,
      { includeBusiness: true },
      "2026-10-16" as never,
    );
    const year = h.years[0]!;
    expect(year.transactionIds.sort()).toEqual(["a", "b"]);
    expect(year.byCategory[0]?.transactionIds.sort()).toEqual(["a", "b"]);
  });
});

describe("monthlyCostFor", () => {
  it("normalizes frequencies", () => {
    expect(monthlyCostFor({ amount: 1000, frequency: "monthly" })).toBe(1000);
    expect(monthlyCostFor({ amount: 12000, frequency: "annual" })).toBe(1000);
    expect(monthlyCostFor({ amount: 250, frequency: "weekly" })).toBe(Math.round((250 * 52) / 12));
  });
});

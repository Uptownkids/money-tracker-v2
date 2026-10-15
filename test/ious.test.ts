/**
 * IOU (Split) engine tests: countedIouTotal filtering, settleIou, the
 * settlement movement builder, and the countsAsIncome exclusion rule.
 * Integer minor units throughout; no float math.
 */
import { describe, expect, it } from "vitest";
import {
  buildSettlementTransaction,
  countedIouTotal,
  settleIou,
} from "../src/domain/engine/ious.js";
import { countsAsIncome } from "../src/domain/entities/transaction.js";
import {
  deriveBalances,
  primaryDelta,
} from "../src/domain/engine/balances.js";
import { confirmPaydayIncome } from "../src/domain/engine/paydayRun.js";
import type { DateOnly } from "../src/domain/dates/dateOnly.js";
import type { Split } from "../src/domain/entities/split.js";
import { mkAccount, mkSplit, mkTransaction } from "./helpers.js";

const WINDOW_END: DateOnly = "2026-10-31";
const BASE = "USD";

const counted = (o: Partial<Split> = {}): Split =>
  mkSplit({
    direction: "TheyOweMe",
    countOnIt: true,
    settled: false,
    expectedBy: "2026-10-20",
    currency: "USD",
    amount: 5000,
    ...o,
  });

describe("countedIouTotal", () => {
  it("counts TheyOweMe + countOnIt + unsettled + expectedBy in window + base currency", () => {
    expect(countedIouTotal([counted()], WINDOW_END, BASE)).toBe(5000);
  });

  it("sums multiple counted IOUs", () => {
    expect(
      countedIouTotal(
        [counted({ amount: 5000 }), counted({ amount: 2500 })],
        WINDOW_END,
        BASE,
      ),
    ).toBe(7500);
  });

  it("excludes IOweThem even when countOnIt is set", () => {
    expect(
      countedIouTotal(
        [counted({ direction: "IOweThem", amount: 9999 })],
        WINDOW_END,
        BASE,
      ),
    ).toBe(0);
  });

  it("excludes settled IOUs", () => {
    expect(countedIouTotal([counted({ settled: true })], WINDOW_END, BASE)).toBe(
      0,
    );
  });

  it("excludes IOUs with countOnIt false", () => {
    expect(
      countedIouTotal([counted({ countOnIt: false })], WINDOW_END, BASE),
    ).toBe(0);
  });

  it("excludes IOUs with no expectedBy date", () => {
    const s = counted();
    delete s.expectedBy;
    expect(countedIouTotal([s], WINDOW_END, BASE)).toBe(0);
  });

  it("excludes IOUs expected after the window end", () => {
    expect(
      countedIouTotal(
        [counted({ expectedBy: "2026-11-01" })],
        WINDOW_END,
        BASE,
      ),
    ).toBe(0);
  });

  it("includes IOUs expected exactly on the window end", () => {
    expect(
      countedIouTotal(
        [counted({ expectedBy: WINDOW_END })],
        WINDOW_END,
        BASE,
      ),
    ).toBe(5000);
  });

  it("excludes foreign-currency IOUs", () => {
    expect(
      countedIouTotal([counted({ currency: "EUR" })], WINDOW_END, BASE),
    ).toBe(0);
  });

  it("returns 0 for an empty list", () => {
    expect(countedIouTotal([], WINDOW_END, BASE)).toBe(0);
  });
});

describe("settleIou", () => {
  it("sets settled and settledAt without mutating the input", () => {
    const before = counted({ id: "iou-1" });
    const snapshot = { ...before };
    const now = "2026-10-15T16:42:00.000Z";
    const after = settleIou(before, now);
    expect(after.settled).toBe(true);
    expect(after.settledAt).toBe(now);
    expect(before).toEqual(snapshot);
    expect(after).not.toBe(before);
  });

  it("settle without recording creates no transaction: nothing changes except settled and settledAt", () => {
    // The settle sheet's explicit "Settle without recording" choice calls
    // settleIou directly and persists no transaction row. settleIou is a
    // flag flip only — no new transaction was created and no amounts or
    // links were touched.
    const before = counted({ id: "iou-2" });
    const after = settleIou(before, "2026-10-15T16:42:00.000Z");
    expect(after).toEqual({
      ...before,
      settled: true,
      settledAt: "2026-10-15T16:42:00.000Z",
    });
  });
});

describe("countsAsIncome", () => {
  it("counts plain Income rows", () => {
    expect(countsAsIncome(mkTransaction({ type: "Income" }))).toBe(true);
  });

  it("excludes Income rows that settle an IOU (splitId set)", () => {
    expect(
      countsAsIncome(mkTransaction({ type: "Income", splitId: "iou-9" })),
    ).toBe(false);
  });

  it("excludes Refund, Expense, and Transfer rows", () => {
    expect(countsAsIncome(mkTransaction({ type: "Refund" }))).toBe(false);
    expect(countsAsIncome(mkTransaction({ type: "Expense" }))).toBe(false);
    expect(
      countsAsIncome(mkTransaction({ type: "Transfer" })),
    ).toBe(false);
  });
});

describe("buildSettlementTransaction", () => {
  const NOW = "2026-10-15T16:42:00.000Z";
  const DATE: DateOnly = "2026-10-15";

  it("TheyOweMe + linked expense: builds a Refund with refundOfTransactionId and splitId", () => {
    const expense = mkTransaction({
      id: "tx-exp",
      type: "Expense",
      amount: 2500,
      currency: "USD",
      accountId: "a1",
      categoryId: "cat-dining",
      payee: "Dinner",
      status: "Cleared",
    });
    const split = mkSplit({
      id: "iou-3",
      direction: "TheyOweMe",
      amount: 2500,
      currency: "USD",
      linkedTransactionId: "tx-exp",
    });
    const tx = buildSettlementTransaction({
      split,
      accountId: "a1",
      date: DATE,
      nowIso: NOW,
      linkedExpense: expense,
    });
    expect(tx.type).toBe("Refund");
    expect(tx.refundOfTransactionId).toBe("tx-exp");
    expect(tx.splitId).toBe("iou-3");
    expect(tx.amount).toBe(2500);
    expect(tx.currency).toBe("USD");
    expect(tx.accountId).toBe("a1");
    expect(tx.categoryId).toBe("cat-dining");
    expect(tx.status).toBe("Cleared");
    expect(tx.payee).toBe("Sam");
  });

  it("TheyOweMe + linked expense: refund reduces the original category's spending and is never income", () => {
    const expense = mkTransaction({
      id: "tx-exp",
      type: "Expense",
      amount: 2500,
      accountId: "a1",
      categoryId: "cat-dining",
      status: "Cleared",
    });
    const split = mkSplit({
      id: "iou-3",
      direction: "TheyOweMe",
      amount: 2500,
      linkedTransactionId: "tx-exp",
    });
    const refund = buildSettlementTransaction({
      split,
      accountId: "a1",
      date: DATE,
      nowIso: NOW,
      linkedExpense: expense,
    });
    // Category net spending via the balances engine's own delta: the
    // expense (-2500) plus the refund (+2500) nets to zero.
    const categoryNet = [expense, refund]
      .filter((t) => t.categoryId === "cat-dining")
      .reduce((acc, t) => acc + primaryDelta(t), 0);
    expect(categoryNet).toBe(0);
    // Account balance: money back in (10000 - 2500 + 2500).
    const acct = mkAccount({ id: "a1", startingBalance: 10000 });
    expect(deriveBalances([acct], [expense, refund])).toEqual({ a1: 10000 });
    // Never income.
    expect(countsAsIncome(refund)).toBe(false);
  });

  it("TheyOweMe standalone: builds an Income inflow with splitId, excluded from income totals", () => {
    const split = mkSplit({
      id: "iou-4",
      direction: "TheyOweMe",
      amount: 5000,
      currency: "USD",
      linkedTransactionId: "",
    });
    const tx = buildSettlementTransaction({
      split,
      accountId: "a1",
      date: DATE,
      nowIso: NOW,
    });
    expect(tx.type).toBe("Income");
    expect(tx.splitId).toBe("iou-4");
    expect(tx.refundOfTransactionId).toBeUndefined();
    expect(tx.amount).toBe(5000);
    expect(tx.status).toBe("Cleared");
    // Money in: the account balance still rises.
    const acct = mkAccount({ id: "a1", startingBalance: 10000 });
    expect(deriveBalances([acct], [tx])).toEqual({ a1: 15000 });
    // But it is excluded from every income total: countsAsIncome is the
    // shared gate, and an income-total reduce over mixed rows skips it.
    expect(countsAsIncome(tx)).toBe(false);
    const paycheck = mkTransaction({
      type: "Income",
      amount: 226341,
      status: "Cleared",
    });
    const incomeTotal = [paycheck, tx]
      .filter(countsAsIncome)
      .reduce((acc, t) => acc + t.amount, 0);
    expect(incomeTotal).toBe(226341);
  });

  it("confirmPaydayIncome never matches a Scheduled Income row carrying a splitId", () => {
    const ruleId = "rule-pay";
    const iouRow = mkTransaction({
      type: "Income",
      status: "Scheduled",
      recurringRuleId: ruleId,
      occurrenceDate: DATE,
      splitId: "iou-x",
      amount: 5000,
    });
    const res = confirmPaydayIncome(
      [iouRow],
      ruleId,
      DATE,
      5000,
      "Cleared",
      NOW,
    );
    expect(res.confirmed).toBe(false);
    // Control: the same row without a splitId still confirms.
    const plain = mkTransaction({
      type: "Income",
      status: "Scheduled",
      recurringRuleId: ruleId,
      occurrenceDate: DATE,
      amount: 5000,
    });
    const res2 = confirmPaydayIncome([plain], ruleId, DATE, 5000, "Cleared", NOW);
    expect(res2.confirmed).toBe(true);
  });

  it("TheyOweMe with a missing linked expense: falls back to a plain inflow, not a refund", () => {
    const split = mkSplit({
      id: "iou-6",
      direction: "TheyOweMe",
      amount: 1200,
      linkedTransactionId: "tx-gone",
    });
    const tx = buildSettlementTransaction({
      split,
      accountId: "a1",
      date: DATE,
      nowIso: NOW,
    });
    expect(tx.type).toBe("Income");
    expect(tx.splitId).toBe("iou-6");
    expect(tx.refundOfTransactionId).toBeUndefined();
    expect(countsAsIncome(tx)).toBe(false);
  });

  it("IOweThem: builds an Expense outflow with splitId", () => {
    const split = mkSplit({
      id: "iou-5",
      direction: "IOweThem",
      amount: 3000,
      currency: "USD",
      linkedTransactionId: "",
    });
    const tx = buildSettlementTransaction({
      split,
      accountId: "a1",
      date: DATE,
      nowIso: NOW,
    });
    expect(tx.type).toBe("Expense");
    expect(tx.splitId).toBe("iou-5");
    expect(tx.amount).toBe(3000);
    expect(tx.status).toBe("Cleared");
    expect(tx.payee).toBe("Sam");
    const acct = mkAccount({ id: "a1", startingBalance: 10000 });
    expect(deriveBalances([acct], [tx])).toEqual({ a1: 7000 });
    expect(countsAsIncome(tx)).toBe(false);
  });
});

/** Balance-correction writers: the four money-appeared options, unlogged spending, card correction. */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { MoneyTrackerDB } from "../src/data/db.js";
import { createRepositories } from "../src/data/repositories/index.js";
import {
  applyCardCorrection,
  applyMoneyAppeared,
  applyUnloggedSpending,
  type AdjustTarget,
} from "../src/app/adjustApply.js";
import {
  BALANCE_CORRECTION_TAG,
  countsAsIncome,
} from "../src/domain/entities/transaction.js";
import { deriveBalances } from "../src/domain/engine/balances.js";
import { monthlyCashFlow } from "../src/domain/engine/insights.js";
import { mkAccount, mkCategory, mkTransaction } from "./helpers.js";
import type { MinorUnits } from "../src/domain/money/money.js";
import type { DateOnly } from "../src/domain/dates/dateOnly.js";

const TODAY = "2026-10-15" as DateOnly;
const NOW = "2026-10-15T12:00:00.000Z";

let db: MoneyTrackerDB;
afterEach(async () => {
  await db?.delete();
});

async function setup() {
  db = new MoneyTrackerDB(`test-adjust-${Date.now()}-${Math.random()}`);
  const repos = createRepositories(db);
  await repos.accounts.put(mkAccount({ id: "a1", name: "Checking", type: "Checking", currency: "USD", startingBalance: 10000 }));
  await repos.categories.put(mkCategory({ id: "c-exp", name: "Food", kind: "expense" }));
  await repos.categories.put(mkCategory({ id: "c-inc", name: "Income", kind: "income" }));
  const target: AdjustTarget = { accountId: "a1", currency: "USD", date: TODAY, nowIso: NOW };
  return { repos, target };
}

async function balanceOf(repos: ReturnType<typeof createRepositories>) {
  const [accounts, txs] = await Promise.all([
    repos.accounts.getAll(),
    repos.transactions.getAll(),
  ]);
  return deriveBalances(accounts, txs)["a1"];
}

describe("applyUnloggedSpending", () => {
  it("records one Uncategorized expense and lowers the balance", async () => {
    const { repos, target } = await setup();
    const tx = await applyUnloggedSpending(repos, target, 7000 as MinorUnits);
    expect(tx.type).toBe("Expense");
    expect(tx.payee).toBe("Unlogged spending");
    expect(tx.amount).toBe(7000);
    const cat = await repos.categories.getById(tx.categoryId as string);
    expect(cat?.name).toBe("Uncategorized");
    expect(await balanceOf(repos)).toBe(3000);
  });
});

describe("applyMoneyAppeared", () => {
  it("refund: money back in, never income, nets against spending", async () => {
    const { repos, target } = await setup();
    const tx = await applyMoneyAppeared(repos, target, 3000 as MinorUnits, "refund");
    expect(tx.type).toBe("Refund");
    expect(tx.payee).toBe("Refund");
    expect(tx.amount).toBe(3000);
    expect(tx.status).toBe("Cleared");
    expect(countsAsIncome(tx)).toBe(false);
    expect(await balanceOf(repos)).toBe(13000);
  });

  it("iou-repayment: creates a real split and settles it", async () => {
    const { repos, target } = await setup();
    const tx = await applyMoneyAppeared(repos, target, 5000 as MinorUnits, "iou-repayment", "Cassius");
    // A real TheyOweMe split exists and is settled...
    const splits = await repos.splits.getAll();
    expect(splits).toHaveLength(1);
    expect(splits[0]?.person).toBe("Cassius");
    expect(splits[0]?.direction).toBe("TheyOweMe");
    expect(splits[0]?.settled).toBe(true);
    // ...and the settlement is an Income carrying that real splitId.
    expect(tx.type).toBe("Income");
    expect(tx.splitId).toBe(splits[0]?.id);
    expect(tx.amount).toBe(5000);
    expect(countsAsIncome(tx)).toBe(false);
    expect(await balanceOf(repos)).toBe(15000);
  });

  it("iou-repayment: requires a person", async () => {
    const { repos, target } = await setup();
    await expect(
      applyMoneyAppeared(repos, target, 5000 as MinorUnits, "iou-repayment", "  "),
    ).rejects.toThrow(/Who repaid you/);
    expect(await repos.splits.getAll()).toHaveLength(0);
    expect(await repos.transactions.getAll()).toHaveLength(0);
  });

  it("forgotten-income: plain income with the given payee", async () => {
    const { repos, target } = await setup();
    const tx = await applyMoneyAppeared(repos, target, 2000 as MinorUnits, "forgotten-income", "Azia");
    expect(tx.type).toBe("Income");
    expect(tx.payee).toBe("Azia");
    expect(countsAsIncome(tx)).toBe(true);
    expect(await balanceOf(repos)).toBe(12000);
  });

  it("forgotten-income: defaults the payee", async () => {
    const { repos, target } = await setup();
    const tx = await applyMoneyAppeared(repos, target, 2000 as MinorUnits, "forgotten-income");
    expect(tx.payee).toBe("Forgotten income");
    expect(countsAsIncome(tx)).toBe(true);
  });

  it("just-correct: tagged inflow that never counts as income", async () => {
    const { repos, target } = await setup();
    const tx = await applyMoneyAppeared(repos, target, 1500 as MinorUnits, "just-correct");
    expect(tx.type).toBe("Income");
    expect(tx.payee).toBe("Balance correction");
    expect(tx.tags).toContain(BALANCE_CORRECTION_TAG);
    expect(countsAsIncome(tx)).toBe(false);
    expect(await balanceOf(repos)).toBe(11500);
  });
});

describe("applyCardCorrection", () => {
  it("records a tagged paydown inflow on the card, never income", async () => {
    db = new MoneyTrackerDB(`test-adjust-card-${Date.now()}-${Math.random()}`);
    const repos = createRepositories(db);
    await repos.accounts.put(
      mkAccount({ id: "card1", name: "Chase Sapphire", type: "CreditCard", currency: "USD", startingBalance: -93492 }),
    );
    await repos.categories.put(mkCategory({ id: "c-inc", name: "Income", kind: "income" }));
    const target: AdjustTarget = { accountId: "card1", currency: "USD", date: TODAY, nowIso: NOW };
    const tx = await applyCardCorrection(repos, target, 13492 as MinorUnits);
    expect(tx.type).toBe("Income");
    expect(tx.tags).toContain(BALANCE_CORRECTION_TAG);
    expect(countsAsIncome(tx)).toBe(false);
    const [accounts, txs] = await Promise.all([
      repos.accounts.getAll(),
      repos.transactions.getAll(),
    ]);
    expect(deriveBalances(accounts, txs)["card1"]).toBe(-80000);
  });
});

describe("income totals exclude corrections", () => {
  it("monthlyCashFlow never includes a just-correct inflow in income", () => {
    const normal = mkTransaction({
      type: "Income",
      amount: 226341,
      date: "2026-10-15",
      payee: "Paycheck",
      tags: [],
    });
    const correction = mkTransaction({
      type: "Income",
      amount: 1500,
      date: "2026-10-16",
      payee: "Balance correction",
      tags: [BALANCE_CORRECTION_TAG],
    });
    const iouSettlement = mkTransaction({
      type: "Income",
      amount: 5000,
      date: "2026-10-17",
      payee: "Cassius",
      splitId: "split-1",
      tags: [],
    });
    const flow = monthlyCashFlow([normal, correction, iouSettlement], "2026-10");
    expect(flow.income).toBe(226341);
  });

  it("countsAsIncome is false for tagged corrections and split inflows, true for real income", () => {
    expect(countsAsIncome(mkTransaction({ type: "Income", tags: [BALANCE_CORRECTION_TAG] }))).toBe(false);
    expect(countsAsIncome(mkTransaction({ type: "Income", splitId: "s1" }))).toBe(false);
    expect(countsAsIncome(mkTransaction({ type: "Income", tags: [] }))).toBe(true);
    expect(countsAsIncome(mkTransaction({ type: "Refund", tags: [] }))).toBe(false);
  });
});

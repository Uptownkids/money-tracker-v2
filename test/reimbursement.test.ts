/**
 * Trip reimbursement: reimbursable expenses accumulate on one TheyOweMe
 * IOU (never counted in safe-to-spend); settling records a Refund per
 * covered receipt so trip spending nets to zero with zero income;
 * rejected receipts stay as ordinary spending.
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { MoneyTrackerDB } from "../src/data/db.js";
import { createRepositories } from "../src/data/repositories/index.js";
import {
  REIMBURSEMENT_IOU_PERSON,
  attachExpenseToReimbursement,
  findOpenReimbursementSplit,
  getOrCreateReimbursementSplit,
  isReimbursementSplit,
  linkedReimbursementExpenses,
  settleReimbursement,
} from "../src/app/reimbursement.js";
import {
  countedIouTotal,
  countsTowardAvailable,
} from "../src/domain/engine/ious.js";
import { countsAsIncome } from "../src/domain/entities/transaction.js";
import {
  monthlyCashFlow,
  spendingByCategory,
} from "../src/domain/engine/insights.js";
import { mkAccount, mkCategory, mkTransaction } from "./helpers.js";
import type { MinorUnits } from "../src/domain/money/money.js";
import type { DateOnly } from "../src/domain/dates/dateOnly.js";
import type { Transaction } from "../src/domain/entities/transaction.js";

const TODAY = "2026-10-15" as DateOnly;
const RETURN_DAY = "2026-10-26" as DateOnly;
const NOW = "2026-10-15T12:00:00.000Z";

let db: MoneyTrackerDB;
afterEach(async () => {
  await db?.delete();
});

async function setup() {
  db = new MoneyTrackerDB(`test-reimburse-${Date.now()}-${Math.random()}`);
  const repos = createRepositories(db);
  await repos.accounts.put(
    mkAccount({
      id: "checking",
      name: "Checking",
      type: "Checking",
      currency: "USD",
      startingBalance: 100000,
    }),
  );
  await repos.accounts.put(
    mkAccount({
      id: "card",
      name: "Trip Card",
      type: "CreditCard",
      currency: "USD",
      startingBalance: 0,
    }),
  );
  await repos.categories.put(
    mkCategory({ id: "c-food", name: "Food", kind: "expense" }),
  );
  await repos.categories.put(
    mkCategory({ id: "c-travel", name: "Travel", kind: "expense" }),
  );
  return { repos };
}

interface SavedExpense {
  tx: Transaction;
  splitId: string;
}

/** Simulate a Quick-Log save with the Reimbursable toggle on. */
async function saveReimbursableExpense(
  repos: ReturnType<typeof createRepositories>,
  o: { amount: number; payee: string; categoryId: string },
): Promise<SavedExpense> {
  const tx = mkTransaction({
    type: "Expense",
    amount: o.amount as MinorUnits,
    payee: o.payee,
    accountId: "card",
    categoryId: o.categoryId,
    currency: "USD",
    date: TODAY,
    status: "Cleared",
  });
  await repos.transactions.put(tx);
  const split = await getOrCreateReimbursementSplit(repos, tx.currency, NOW);
  await attachExpenseToReimbursement(repos, split.id, tx);
  return { tx, splitId: split.id };
}

describe("reimbursable expenses accumulate on one IOU", () => {
  it("creates the IOU on first use and grows it with each expense", async () => {
    const { repos } = await setup();
    const first = await saveReimbursableExpense(repos, {
      amount: 4500,
      payee: "Chipotle",
      categoryId: "c-food",
    });
    const second = await saveReimbursableExpense(repos, {
      amount: 12000,
      payee: "Uber",
      categoryId: "c-travel",
    });

    expect(first.splitId).toBe(second.splitId);
    const splits = await repos.splits.getAll();
    expect(splits).toHaveLength(1);
    const split = splits[0]!;
    expect(split.person).toBe(REIMBURSEMENT_IOU_PERSON);
    expect(split.direction).toBe("TheyOweMe");
    expect(split.settled).toBe(false);
    expect(split.countOnIt).toBe(false);
    expect(split.amount).toBe(16500);
    expect(isReimbursementSplit(split)).toBe(true);

    const txs = await repos.transactions.getAll();
    for (const t of txs) expect(t.splitId).toBe(split.id);
    const linked = linkedReimbursementExpenses(txs, split.id);
    expect(linked.map((t) => t.payee)).toEqual(["Chipotle", "Uber"]);
  });

  it("finds the open IOU instead of creating a second one", async () => {
    const { repos } = await setup();
    const a = await getOrCreateReimbursementSplit(repos, "USD", NOW);
    const b = await getOrCreateReimbursementSplit(repos, "USD", NOW);
    expect(a.id).toBe(b.id);
    expect(await repos.splits.count()).toBe(1);
  });

  it("a settled IOU is not reused — the next expense starts a fresh one", async () => {
    const { repos } = await setup();
    const { tx, splitId } = await saveReimbursableExpense(repos, {
      amount: 1000,
      payee: "Taxi",
      categoryId: "c-travel",
    });
    await settleReimbursement(repos, {
      splitId,
      coveredExpenseIds: [tx.id],
      receivingAccountId: "checking",
      date: RETURN_DAY,
      nowIso: NOW,
    });
    expect(
      findOpenReimbursementSplit(await repos.splits.getAll()),
    ).toBeUndefined();
    const fresh = await getOrCreateReimbursementSplit(repos, "USD", NOW);
    expect(fresh.id).not.toBe(splitId);
    expect(fresh.amount).toBe(0);
  });

  it("rejects a different-currency expense loudly", async () => {
    const { repos } = await setup();
    await saveReimbursableExpense(repos, {
      amount: 1000,
      payee: "Taxi",
      categoryId: "c-travel",
    });
    await expect(
      getOrCreateReimbursementSplit(repos, "EUR", NOW),
    ).rejects.toThrow(/USD/);
  });

  it("only expenses can be attached", async () => {
    const { repos } = await setup();
    const split = await getOrCreateReimbursementSplit(repos, "USD", NOW);
    const income = mkTransaction({ type: "Income", amount: 5000 as MinorUnits });
    await repos.transactions.put(income);
    await expect(
      attachExpenseToReimbursement(repos, split.id, income),
    ).rejects.toThrow(/Only expenses/);
  });
});

describe("the IOU never affects safe-to-spend while countOnIt is false", () => {
  it("countedIouTotal excludes it, even with an expected-by date", async () => {
    const { repos } = await setup();
    await saveReimbursableExpense(repos, {
      amount: 16500,
      payee: "Hotel",
      categoryId: "c-travel",
    });
    const windowEnd = "2026-10-30" as DateOnly;
    let splits = await repos.splits.getAll();
    expect(countsTowardAvailable(splits[0]!, windowEnd, "USD")).toBe(false);
    expect(countedIouTotal(splits, windowEnd, "USD")).toBe(0);

    // Even dated inside the window, countOnIt false keeps it out.
    await repos.splits.put({
      ...splits[0]!,
      expectedBy: "2026-10-20" as DateOnly,
    });
    splits = await repos.splits.getAll();
    expect(countedIouTotal(splits, windowEnd, "USD")).toBe(0);
  });
});

describe("settling creates linked refunds and zero income", () => {
  it("one refund per covered receipt; trip spending nets to zero", async () => {
    const { repos } = await setup();
    const e1 = await saveReimbursableExpense(repos, {
      amount: 4500,
      payee: "Chipotle",
      categoryId: "c-food",
    });
    const e2 = await saveReimbursableExpense(repos, {
      amount: 12000,
      payee: "Uber",
      categoryId: "c-travel",
    });

    const { refunds, keptAsSpending } = await settleReimbursement(repos, {
      splitId: e1.splitId,
      coveredExpenseIds: [e1.tx.id, e2.tx.id],
      receivingAccountId: "checking",
      date: RETURN_DAY,
      nowIso: NOW,
    });

    expect(keptAsSpending).toHaveLength(0);
    expect(refunds).toHaveLength(2);
    const byLink = new Map(refunds.map((r) => [r.refundOfTransactionId, r]));
    expect(byLink.get(e1.tx.id)?.amount).toBe(4500);
    expect(byLink.get(e2.tx.id)?.amount).toBe(12000);
    for (const r of refunds) {
      expect(r.type).toBe("Refund");
      expect(r.accountId).toBe("checking"); // money lands in checking…
      expect(r.splitId).toBe(e1.splitId);
      expect(r.status).toBe("Cleared");
      expect(countsAsIncome(r)).toBe(false);
    }
    // …not on the card the trip was spent on.
    const cardTx = refunds.filter((r) => r.accountId === "card");
    expect(cardTx).toHaveLength(0);

    const split = await repos.splits.getById(e1.splitId);
    expect(split?.settled).toBe(true);
    expect(split?.amount).toBe(16500);

    const txs = await repos.transactions.getAll();
    const flow = monthlyCashFlow(txs, "2026-10");
    expect(flow.income).toBe(0);
    expect(flow.expenses).toBe(0); // 16500 spent − 16500 refunded
    const cats = await repos.categories.getAll();
    expect(spendingByCategory(txs, "2026-10", cats)).toEqual([]);
  });

  it("the refund carries the expense's category so category spending nets out", async () => {
    const { repos } = await setup();
    const e1 = await saveReimbursableExpense(repos, {
      amount: 4500,
      payee: "Chipotle",
      categoryId: "c-food",
    });
    await settleReimbursement(repos, {
      splitId: e1.splitId,
      coveredExpenseIds: [e1.tx.id],
      receivingAccountId: "checking",
      date: RETURN_DAY,
      nowIso: NOW,
    });
    const txs = await repos.transactions.getAll();
    const refund = txs.find((t) => t.type === "Refund")!;
    expect(refund.categoryId).toBe("c-food");
    expect(refund.notes).toMatch(/Chipotle/);
  });
});

describe("partial reimbursement leaves rejected receipts as spending", () => {
  it("unchecked expenses get no refund, stay categorized, and detach", async () => {
    const { repos } = await setup();
    const e1 = await saveReimbursableExpense(repos, {
      amount: 4500,
      payee: "Chipotle",
      categoryId: "c-food",
    });
    const e2 = await saveReimbursableExpense(repos, {
      amount: 12000,
      payee: "Uber",
      categoryId: "c-travel",
    });

    // The Uber receipt was rejected — only Chipotle is covered.
    const { refunds, keptAsSpending } = await settleReimbursement(repos, {
      splitId: e1.splitId,
      coveredExpenseIds: [e1.tx.id],
      receivingAccountId: "checking",
      date: RETURN_DAY,
      nowIso: NOW,
    });

    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.refundOfTransactionId).toBe(e1.tx.id);
    expect(keptAsSpending.map((t) => t.id)).toEqual([e2.tx.id]);

    // The rejected expense is detached from the IOU but otherwise intact.
    const txs = await repos.transactions.getAll();
    const kept = txs.find((t) => t.id === e2.tx.id)!;
    expect(kept.splitId).toBeUndefined();
    expect(kept.type).toBe("Expense");
    expect(kept.categoryId).toBe("c-travel");

    // The settled IOU records what was actually reimbursed.
    const split = await repos.splits.getById(e1.splitId);
    expect(split?.settled).toBe(true);
    expect(split?.amount).toBe(4500);

    // Insights: only the rejected receipt still counts as spending.
    const flow = monthlyCashFlow(txs, "2026-10");
    expect(flow.income).toBe(0);
    expect(flow.expenses).toBe(12000);
    const cats = await repos.categories.getAll();
    const byCat = spendingByCategory(txs, "2026-10", cats);
    expect(byCat).toHaveLength(1);
    expect(byCat[0]?.name).toBe("Travel");
    expect(byCat[0]?.amount).toBe(12000);
  });
});

/**
 * Transfer review: miscategorized Expenses (filed under the Transfer
 * category) are found for review, converted to real Transfers, or
 * recategorized — never silently hidden.
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../src/data/db.js";
import { createRepositories } from "../src/data/repositories/index.js";
import {
  expenseCategories,
  findTransferCategoryExpenses,
  transferCategoryIds,
} from "../src/domain/entities/category.js";
import {
  convertExpenseToTransfer,
  recategorizeExpense,
} from "../src/app/transferReview.js";
import { deriveBalances } from "../src/domain/engine/balances.js";
import { mkAccount, mkCategory, mkTransaction } from "./helpers.js";

const transferCat = () => mkCategory({ id: "cat-transfer", name: "Transfer", kind: "expense" });
const foodCat = () => mkCategory({ id: "cat-food", name: "Food", kind: "expense" });

describe("transferCategoryIds", () => {
  it("matches the seeded id and the name (rename-safe)", () => {
    const ids = transferCategoryIds([
      transferCat(),
      mkCategory({ id: "cat-x", name: "Transfer", kind: "expense" }),
      foodCat(),
    ]);
    expect(ids).toEqual(new Set(["cat-transfer", "cat-x"]));
  });
});

describe("findTransferCategoryExpenses", () => {
  const cats = [transferCat(), foodCat()];

  it("finds Expenses filed under the Transfer category", () => {
    const txs = [
      mkTransaction({ id: "t1", type: "Expense", categoryId: "cat-transfer" }),
      mkTransaction({ id: "t2", type: "Expense", categoryId: "cat-food" }),
      mkTransaction({ id: "t3", type: "Transfer", categoryId: null }),
      mkTransaction({ id: "t4", type: "Expense", categoryId: null }),
    ];
    expect(findTransferCategoryExpenses(txs, cats).map((t) => t.id)).toEqual(["t1"]);
  });

  it("returns nothing when the data is clean", () => {
    const txs = [mkTransaction({ type: "Expense", categoryId: "cat-food" })];
    expect(findTransferCategoryExpenses(txs, cats)).toEqual([]);
  });
});

describe("expenseCategories", () => {
  it("never offers Transfer as an expense category", () => {
    const cats = [transferCat(), foodCat(), mkCategory({ id: "cat-inc", name: "Income", kind: "income" })];
    expect(expenseCategories(cats).map((c) => c.id)).toEqual(["cat-food"]);
  });
});

describe("convertExpenseToTransfer / recategorizeExpense", () => {
  afterEach(async () => {
    const db = getDb();
    await db
      .transaction("rw", db.tables, async () => {
        await Promise.all(db.tables.map((t) => t.clear()));
      })
      .catch(() => {});
  });

  async function seed() {
    const db = getDb();
    const repos = createRepositories(db);
    await repos.accounts.put(mkAccount({ id: "chk", name: "Checking", startingBalance: 100000 }));
    await repos.accounts.put(mkAccount({ id: "sav", name: "Savings", startingBalance: 0 }));
    await repos.categories.put(transferCat());
    await repos.categories.put(foodCat());
    await repos.transactions.put(
      mkTransaction({
        id: "move-1",
        type: "Expense",
        amount: 15000,
        accountId: "chk",
        categoryId: "cat-transfer",
        payee: "To savings",
        status: "Cleared",
      }),
    );
    return repos;
  }

  it("converting credits the destination (which the Expense never did)", async () => {
    const repos = await seed();
    const accounts = await repos.accounts.getAll();
    const before = deriveBalances(accounts, await repos.transactions.getAll());
    expect(before["chk"]).toBe(85000);
    expect(before["sav"]).toBe(0);

    const converted = await convertExpenseToTransfer(repos, "move-1", "sav");
    expect(converted.type).toBe("Transfer");
    expect(converted.transferToAccountId).toBe("sav");
    expect(converted.categoryId).toBeNull();

    const after = deriveBalances(accounts, await repos.transactions.getAll());
    expect(after["chk"]).toBe(85000); // source unchanged: -15000 either way
    expect(after["sav"]).toBe(15000); // destination finally gets the money

    // The row no longer needs review.
    const remaining = findTransferCategoryExpenses(
      await repos.transactions.getAll(),
      await repos.categories.getAll(),
    );
    expect(remaining).toEqual([]);
  });

  it("converting rejects the same account and unknown destinations", async () => {
    const repos = await seed();
    await expect(convertExpenseToTransfer(repos, "move-1", "chk")).rejects.toThrow(
      "different account",
    );
    await expect(convertExpenseToTransfer(repos, "move-1", "nope")).rejects.toThrow(
      "unknown destination",
    );
    await expect(convertExpenseToTransfer(repos, "missing", "sav")).rejects.toThrow(
      "unknown transaction",
    );
  });

  it("recategorizing keeps it an Expense with the picked category", async () => {
    const repos = await seed();
    const updated = await recategorizeExpense(repos, "move-1", "cat-food", (id) =>
      transferCategoryIds([transferCat()]).has(id),
    );
    expect(updated.type).toBe("Expense");
    expect(updated.categoryId).toBe("cat-food");

    const remaining = findTransferCategoryExpenses(
      await repos.transactions.getAll(),
      await repos.categories.getAll(),
    );
    expect(remaining).toEqual([]);
  });

  it("recategorizing rejects the Transfer category and unknown categories", async () => {
    const repos = await seed();
    const isTransfer = (id: string) => transferCategoryIds([transferCat()]).has(id);
    await expect(recategorizeExpense(repos, "move-1", "cat-transfer", isTransfer)).rejects.toThrow(
      "not Transfer",
    );
    await expect(recategorizeExpense(repos, "move-1", "nope", isTransfer)).rejects.toThrow(
      "unknown category",
    );
  });
});

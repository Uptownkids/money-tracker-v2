/**
 * Needs-review inbox action tests (Phase B).
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { MoneyTrackerDB } from "../src/data/db.js";
import { createRepositories, type Repositories } from "../src/data/repositories/index.js";
import {
  confirmReviewItem,
  confirmTransferPair,
  createBillFromReviewItem,
  ignoreReviewItem,
  linkBillReviewItem,
  markTransferReviewItem,
  recategorizeReviewItem,
} from "../src/app/reviewActions.js";
import type { ReviewItem } from "../src/domain/entities/reviewItem.js";
import { mkAccount, mkCategory, mkRule, mkTransaction } from "./helpers.js";

const NOW = "2026-10-16T12:00:00.000Z";

describe("reviewActions", () => {
  let db: MoneyTrackerDB;
  let repos: Repositories;

  afterEach(async () => {
    await db?.delete();
  });

  async function setup() {
    db = new MoneyTrackerDB(`test-rev-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    repos = createRepositories(db);
    await repos.accounts.put(mkAccount({ id: "acct-checking", name: "Checking", type: "Checking" }));
    await repos.accounts.put(mkAccount({ id: "acct-savings", name: "Savings", type: "Savings" }));
    await repos.categories.put(mkCategory({ id: "cat-coffee", name: "Coffee", kind: "expense" }));
    await repos.categories.put(mkCategory({ id: "cat-other", name: "Other", kind: "expense" }));
    await repos.categories.put(mkCategory({ id: "cat-income", name: "Income", kind: "income" }));
  }

  function item(over: Partial<ReviewItem> = {}): ReviewItem {
    return {
      id: `ri-${Math.random().toString(36).slice(2)}`,
      transactionId: "tx-1",
      status: "open",
      reasons: ["uncategorized"],
      merchantKey: "STARBUCKS",
      guess: { type: "Expense", categoryId: "cat-coffee", payee: "Starbucks" },
      createdAt: NOW,
      ...over,
    };
  }

  async function setupItem(over: Partial<ReviewItem> = {}) {
    const tx = mkTransaction({
      id: "tx-1",
      accountId: "acct-checking",
      date: "2026-10-16",
      amount: 450,
      payee: "STARBUCKS",
      status: "Cleared",
    });
    await repos.transactions.put(tx);
    const ri = item(over);
    await repos.reviewItems.put(ri);
    return ri;
  }

  it("confirm applies the guess and resolves the item", async () => {
    await setup();
    const ri = await setupItem();
    await confirmReviewItem(repos, ri.id, false);
    const tx = await repos.transactions.getById("tx-1");
    expect(tx).toMatchObject({ categoryId: "cat-coffee", payee: "Starbucks" });
    expect((await repos.reviewItems.getById(ri.id))?.status).toBe("resolved");
  });

  it("always-do-this saves a rule and applies it to the same merchant's other items", async () => {
    await setup();
    const ri1 = await setupItem();
    await repos.transactions.put(
      mkTransaction({ id: "tx-2", accountId: "acct-checking", date: "2026-10-15", amount: 600, payee: "STARBUCKS", status: "Cleared" }),
    );
    const ri2 = item({ transactionId: "tx-2" });
    await repos.reviewItems.put(ri2);

    await confirmReviewItem(repos, ri1.id, true);
    const rule = (await repos.merchantRules.getAll()).find((r) => r.merchantKey === "STARBUCKS");
    expect(rule).toMatchObject({ categoryId: "cat-coffee", payeeName: "Starbucks" });
    // Both items resolved, both transactions categorized.
    expect((await repos.reviewItems.getById(ri2.id))?.status).toBe("resolved");
    expect((await repos.transactions.getById("tx-2"))?.categoryId).toBe("cat-coffee");
  });

  it("recategorize changes the category without a rule when not asked", async () => {
    await setup();
    const ri = await setupItem();
    await recategorizeReviewItem(repos, ri.id, "cat-other", "Coffee Shop", false);
    expect((await repos.transactions.getById("tx-1"))).toMatchObject({
      categoryId: "cat-other",
      payee: "Coffee Shop",
    });
    expect(await repos.merchantRules.getAll()).toHaveLength(0);
  });

  it("mark-as-transfer converts the row to a Transfer", async () => {
    await setup();
    const ri = await setupItem();
    await markTransferReviewItem(repos, ri.id, "acct-savings");
    expect((await repos.transactions.getById("tx-1"))).toMatchObject({
      type: "Transfer",
      transferToAccountId: "acct-savings",
      categoryId: null,
    });
    const settings = await repos.settings.get();
    expect(settings?.confirmedTransferPairs).toContain("acct-checking>acct-savings");
  });

  it("mark-as-transfer refuses the same account", async () => {
    await setup();
    const ri = await setupItem();
    await expect(markTransferReviewItem(repos, ri.id, "acct-checking")).rejects.toThrow();
  });

  it("this-is-my-bill links the row to the rule", async () => {
    await setup();
    const rule = mkRule({ id: "rule-spotify", kind: "Subscription", name: "Spotify", amount: 1299, accountId: "acct-checking", nextDueDate: "2026-11-01" });
    await repos.recurringRules.put(rule);
    const ri = await setupItem();
    await linkBillReviewItem(repos, ri.id, "rule-spotify");
    expect((await repos.transactions.getById("tx-1"))?.recurringRuleId).toBe("rule-spotify");
  });

  it("new-bill creates the rule on the transaction's account and links the row", async () => {
    await setup();
    const ri = await setupItem();
    const ruleId = await createBillFromReviewItem(repos, ri.id, {
      name: "Apple",
      amountMinor: 1099,
      kind: "Subscription",
      frequency: "monthly",
      categoryId: "cat-other",
    });
    const rule = await repos.recurringRules.getById(ruleId);
    expect(rule).toMatchObject({
      kind: "Subscription",
      name: "Apple",
      amount: 1099,
      accountId: "acct-checking",
      categoryId: "cat-other",
      frequency: "monthly",
      nextDueDate: "2026-11-16",
      active: true,
    });
    expect((await repos.transactions.getById("tx-1"))).toMatchObject({
      recurringRuleId: ruleId,
      categoryId: "cat-other",
    });
    expect((await repos.reviewItems.getById(ri.id))?.status).toBe("resolved");
  });

  it("new-bill rejects a blank name, bad amount, or unknown category", async () => {
    await setup();
    const ri = await setupItem();
    const base = { name: "Apple", amountMinor: 1099, kind: "Subscription" as const, frequency: "monthly" as const, categoryId: "cat-other" };
    await expect(createBillFromReviewItem(repos, ri.id, { ...base, name: "  " })).rejects.toThrow(/name/);
    await expect(createBillFromReviewItem(repos, ri.id, { ...base, amountMinor: 0 })).rejects.toThrow(/amount/);
    await expect(createBillFromReviewItem(repos, ri.id, { ...base, categoryId: "nope" })).rejects.toThrow(/category/);
  });

  it("ignore hides the item but leaves the transaction counted", async () => {
    await setup();
    const ri = await setupItem();
    await ignoreReviewItem(repos, ri.id);
    expect((await repos.reviewItems.getById(ri.id))?.status).toBe("ignored");
    expect(await repos.reviewItems.openCount()).toBe(0);
    // Still in the ledger, still Cleared.
    expect((await repos.transactions.getById("tx-1"))?.status).toBe("Cleared");
  });

  it("confirmTransferPair resolves and remembers the route when asked", async () => {
    await setup();
    const ri = await setupItem({
      reasons: ["transfer-unconfirmed"],
      guess: { type: "Transfer", transferToAccountId: "acct-savings", payee: "Transfer" },
    });
    await repos.transactions.put(
      mkTransaction({
        id: "tx-1",
        type: "Transfer",
        accountId: "acct-checking",
        transferToAccountId: "acct-savings",
        categoryId: null,
        date: "2026-10-16",
        amount: 15000,
        payee: "Online transfer",
        status: "Cleared",
      }),
    );
    await confirmTransferPair(repos, ri.id, true);
    const settings = await repos.settings.get();
    expect(settings?.confirmedTransferPairs).toContain("acct-checking>acct-savings");
    expect((await repos.reviewItems.getById(ri.id))?.status).toBe("resolved");
  });
});

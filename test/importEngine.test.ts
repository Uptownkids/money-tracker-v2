/**
 * Import matching-engine tests (Phase B): self-transfers, pairing,
 * bill settling, existing-entry matching, pending->posted, Ref # dedup.
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { MoneyTrackerDB } from "../src/data/db.js";
import { createRepositories, type Repositories } from "../src/data/repositories/index.js";
import { commitImport, planImport } from "../src/app/importEngine.js";
import type { CsvFileInput } from "../src/app/csvImport.js";
import { mkAccount, mkCategory, mkRule, mkTransaction } from "./helpers.js";

const NOW = "2026-10-16T12:00:00.000Z";

describe("importEngine", () => {
  let db: MoneyTrackerDB;
  let repos: Repositories;

  afterEach(async () => {
    await db?.delete();
  });

  async function setup() {
    db = new MoneyTrackerDB(`test-eng-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    repos = createRepositories(db);
    await repos.accounts.put(mkAccount({ id: "acct-checking", name: "Wells Fargo Checking", type: "Checking" }));
    await repos.accounts.put(mkAccount({ id: "acct-way2save", name: "Way2Save", type: "Savings", countsAsSpendable: false }));
    await repos.accounts.put(mkAccount({ id: "acct-amex", name: "Amex Savings", type: "Savings", countsAsSpendable: false }));
    await repos.categories.put(mkCategory({ id: "cat-other", name: "Other", kind: "expense" }));
    await repos.categories.put(mkCategory({ id: "cat-transit", name: "Transit", kind: "expense" }));
    await repos.categories.put(mkCategory({ id: "cat-coffee", name: "Coffee", kind: "expense" }));
    await repos.categories.put(mkCategory({ id: "cat-income", name: "Income", kind: "income" }));
    await repos.settings.save({
      id: "settings",
      baseCurrency: "USD",
      bufferAmount: 0,
      theme: "system",
      notificationsEnabled: false,
      onboardingCompleted: true,
      transferAccountNameMaps: {
        "WAY2SAVE SAVINGS": "acct-way2save",
        "CHECKING": "acct-checking",
        "zelle:acct-checking:TO": "acct-amex",
        "zelle:acct-checking:FROM": "acct-amex",
      },
    } as never);
  }

  const file = (name: string, text: string, appAccountId = "acct-checking"): CsvFileInput => ({
    fileName: name,
    text,
    bankKey: name,
    appAccountId,
  });

  const csv = (rows: string[]) => ["Date,Amount,*,*,Description", ...rows].join("\n");

  async function importText(text: string, appAccountId = "acct-checking") {
    const f = file("import.csv", text, appAccountId);
    const plan = await planImport(repos, [f]);
    return { plan, summary: await commitImport(repos, plan, [f]) };
  }

  it("creates one Transfer for a Way2Save online transfer (checking -> savings)", async () => {
    await setup();
    const { plan, summary } = await importText(
      csv(['10/15/2026,-150.00,,,"ONLINE TRANSFER TO SIDIBE M WAY2SAVE SAVINGS"']),
    );
    expect(plan.summary.transfersNew).toBe(1);
    expect(summary.transfersNew).toBe(1);

    const txs = await repos.transactions.getAll();
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({
      type: "Transfer",
      amount: 15000,
      accountId: "acct-checking",
      transferToAccountId: "acct-way2save",
      categoryId: null,
      status: "Cleared",
    });
    // Unconfirmed pair -> one review item, but the transfer exists.
    const reviews = await repos.reviewItems.open();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.reasons).toContain("transfer-unconfirmed");
  });

  it("pairs the Way2Save side imported later with the existing Transfer", async () => {
    await setup();
    await importText(csv(['10/15/2026,-150.00,,,"ONLINE TRANSFER TO SIDIBE M WAY2SAVE SAVINGS"']));

    const { plan, summary } = await importText(
      csv(['10/15/2026,150.00,,,"ONLINE TRANSFER FROM SIDIBE M CHECKING"']),
      "acct-way2save",
    );
    expect(plan.summary.transfersAbsorbed).toBe(1);
    expect(summary.transfersAbsorbed).toBe(1);

    // Still exactly one Transfer row: no double-count.
    const txs = await repos.transactions.getAll();
    expect(txs).toHaveLength(1);
    expect(txs[0]?.type).toBe("Transfer");
  });

  it("handles Zelle from self and Zelle to self", async () => {
    await setup();
    const { summary } = await importText(
      csv([
        '10/15/2026,25.00,,,"ZELLE FROM MALIKE SIDIBE ON 10/15/2026 REF # 111"',
        '10/16/2026,-30.00,,,"ZELLE TO MALIKE SIDIBE ON 10/16/2026 REF # 222"',
      ]),
    );
    expect(summary.transfersNew).toBe(2);
    const txs = (await repos.transactions.getAll()).filter((t) => t.type === "Transfer");
    expect(txs).toHaveLength(2);
    // FROM self: money coming in -> amex is the source.
    expect(txs.find((t) => t.amount === 2500)).toMatchObject({
      accountId: "acct-amex",
      transferToAccountId: "acct-checking",
    });
    // TO self: money leaving -> checking is the source.
    expect(txs.find((t) => t.amount === 3000)).toMatchObject({
      accountId: "acct-checking",
      transferToAccountId: "acct-amex",
    });
  });

  it("does NOT treat Zelle to another person as a transfer", async () => {
    await setup();
    const { summary } = await importText(
      csv(['10/16/2026,-50.00,,,"ZELLE TO JANE DOE ON 10/16/2026 REF # 333"']),
    );
    expect(summary.transfersNew).toBe(0);
    const txs = await repos.transactions.getAll();
    expect(txs).toHaveLength(1);
    expect(txs[0]?.type).toBe("Expense");
    // Unknown merchant -> review.
    expect(await repos.reviewItems.openCount()).toBe(1);
  });

  it("recognizes a configured name variation", async () => {
    await setup();
    const s = await repos.settings.get();
    await repos.settings.save({ ...(s as object), selfNameVariations: ["SIDIBE M", "MALIKE SIDIBE", "M SIDIBE"] } as never);
    const { summary } = await importText(
      csv(['10/15/2026,-75.00,,,"ONLINE TRANSFER TO M SIDIBE WAY2SAVE SAVINGS"']),
    );
    expect(summary.transfersNew).toBe(1);
  });

  it("dedups on the Zelle Ref # across re-imports", async () => {
    await setup();
    const text = csv(['10/16/2026,-30.00,,,"ZELLE TO MALIKE SIDIBE ON 10/16/2026 REF # 222"']);
    await importText(text);
    const f = file("import.csv", text);
    const plan = await planImport(repos, [f]);
    expect(plan.summary.duplicates).toBe(1);
    expect(plan.summary.newRows).toBe(0);
    // Committing an all-duplicate plan is a no-op: no batch, no rows.
    const summary = await commitImport(repos, plan, [f]);
    expect(summary.batch).toBeNull();
    expect(summary.imported).toBe(0);
    expect((await repos.transactions.getAll()).filter((t) => t.type === "Transfer")).toHaveLength(1);
  });

  it("matches a manually-logged entry instead of duplicating it", async () => {
    await setup();
    await repos.transactions.put(
      mkTransaction({
        id: "manual-1",
        accountId: "acct-checking",
        date: "2026-10-16",
        amount: 450,
        payee: "Coffee",
        categoryId: "cat-coffee",
        status: "Cleared",
      }),
    );
    const { plan, summary } = await importText(
      csv(['10/17/2026,-4.50,,,"PURCHASE AUTHORIZED ON 10/16 STARBUCKS"']),
    );
    expect(plan.summary.matched).toBe(1);
    expect(summary.matched).toBe(1);
    const txs = await repos.transactions.getAll();
    expect(txs).toHaveLength(1); // no second row
    expect(txs[0]).toMatchObject({ id: "manual-1", payee: "Coffee", status: "Cleared" });
    expect(txs[0]?.bankFingerprint).toBeTruthy();
  });

  it("sends ambiguous matches to review instead of choosing", async () => {
    await setup();
    await repos.transactions.put(
      mkTransaction({ id: "m1", accountId: "acct-checking", date: "2026-10-16", amount: 450, payee: "Coffee A", status: "Cleared" }),
    );
    await repos.transactions.put(
      mkTransaction({ id: "m2", accountId: "acct-checking", date: "2026-10-17", amount: 450, payee: "Coffee B", status: "Cleared" }),
    );
    const { plan, summary } = await importText(
      csv(['10/16/2026,-4.50,,,"PURCHASE AUTHORIZED ON 10/16 STARBUCKS"']),
    );
    expect(plan.summary.needsReview).toBeGreaterThanOrEqual(1);
    expect(summary.needsReview).toBeGreaterThanOrEqual(1);
    const reviews = await repos.reviewItems.open();
    expect(reviews.some((r) => r.reasons.includes("ambiguous-match"))).toBe(true);
  });

  it("settles an open Scheduled bill in place (debt payments stay Transfers)", async () => {
    await setup();
    await repos.accounts.put(
      mkAccount({ id: "acct-card", name: "Credit One", type: "CreditCard", countsAsSpendable: false, startingBalance: -99735 }),
    );
    const rule = mkRule({
      id: "rule-card",
      kind: "Bill",
      name: "Credit One minimum",
      amount: 9700,
      accountId: "acct-checking",
      payToAccountId: "acct-card",
      nextDueDate: "2026-10-08",
    });
    await repos.recurringRules.put(rule);
    await repos.transactions.put(
      mkTransaction({
        id: "sched-1",
        type: "Transfer",
        accountId: "acct-checking",
        transferToAccountId: "acct-card",
        categoryId: null,
        date: "2026-10-08",
        amount: 9700,
        payee: "Credit One minimum",
        status: "Scheduled",
        recurringRuleId: "rule-card",
        occurrenceDate: "2026-10-08",
      }),
    );
    const { plan, summary } = await importText(
      csv(['10/08/2026,-97.00,,,"ONLINE PAYMENT TO CREDIT ONE"']),
    );
    expect(plan.summary.billSettled).toBe(1);
    expect(summary.billSettled).toBe(1);
    const settled = await repos.transactions.getById("sched-1");
    expect(settled).toMatchObject({
      status: "Cleared",
      type: "Transfer",
      transferToAccountId: "acct-card",
      recurringRuleId: "rule-card",
    });
  });

  it("updates a Pending row to posted when the amount changed", async () => {
    await setup();
    await repos.transactions.put(
      mkTransaction({
        id: "pend-1",
        accountId: "acct-checking",
        date: "2026-10-14",
        amount: 2500,
        payee: "COFFEE SHOP",
        status: "Pending",
      }),
    );
    const { summary } = await importText(
      csv(['10/15/2026,-28.50,,,"COFFEE SHOP"']),
    );
    expect(summary.matched).toBe(1);
    const updated = await repos.transactions.getById("pend-1");
    expect(updated).toMatchObject({ status: "Cleared", amount: 2850, date: "2026-10-15" });
    expect((await repos.transactions.getAll())).toHaveLength(1);
  });

  it("learned rules win on the next import", async () => {
    await setup();
    await repos.merchantRules.put({
      id: "mr-1",
      merchantKey: "CITI BIKE",
      categoryId: "cat-transit",
      payeeName: "Citi Bike",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const { plan } = await importText(
      csv(['10/14/2026,-8.76,,,"PURCHASE AUTHORIZED ON 10/13 CITI BIKE*TRIP"']),
    );
    expect(plan.summary.needsReview).toBe(0);
    const txs = await repos.transactions.getAll();
    expect(txs[0]).toMatchObject({ categoryId: "cat-transit", payee: "Citi Bike", type: "Expense" });
  });

  it("plan summary shows the full reconciliation before commit", async () => {
    await setup();
    await repos.transactions.put(
      mkTransaction({ id: "manual-1", accountId: "acct-checking", date: "2026-10-16", amount: 450, payee: "Coffee", status: "Cleared" }),
    );
    const plan = await planImport(repos, [
      file("import.csv", csv([
        '10/17/2026,-4.50,,,"PURCHASE AUTHORIZED ON 10/16 STARBUCKS"',
        '10/15/2026,-150.00,,,"ONLINE TRANSFER TO SIDIBE M WAY2SAVE SAVINGS"',
        '10/14/2026,-8.76,,,"PURCHASE AUTHORIZED ON 10/13 CITI BIKE*TRIP"',
      ])),
    ]);
    expect(plan.summary).toMatchObject({
      newRows: 3,
      duplicates: 0,
      matched: 1,
      transfersNew: 1,
    });
    // Citi Bike is unknown on first sight -> review; the transfer pair is
    // unconfirmed -> review.
    expect(plan.summary.needsReview).toBe(2);
  });
});

describe("importEngine transfer confirmation", () => {
  let db2: MoneyTrackerDB;
  let repos2: Repositories;

  afterEach(async () => {
    await db2?.delete();
  });

  async function setup2() {
    db2 = new MoneyTrackerDB(`test-eng2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    repos2 = createRepositories(db2);
    await repos2.accounts.put(mkAccount({ id: "acct-checking", name: "Wells Fargo Checking", type: "Checking" }));
    await repos2.accounts.put(mkAccount({ id: "acct-way2save", name: "Way2Save", type: "Savings" }));
    await repos2.categories.put(mkCategory({ id: "cat-other", name: "Other", kind: "expense" }));
    await repos2.categories.put(mkCategory({ id: "cat-income", name: "Income", kind: "income" }));
    await repos2.settings.save({
      id: "settings",
      baseCurrency: "USD",
      bufferAmount: 0,
      theme: "system",
      notificationsEnabled: false,
      onboardingCompleted: true,
      transferAccountNameMaps: { "WAY2SAVE SAVINGS": "acct-way2save" },
    } as never);
  }

  const csv2 = (rows: string[]) => ["Date,Amount,*,*,Description", ...rows].join("\n");

  it("auto-handles a confirmed pair without review on the next import", async () => {
    await setup2();
    const f = (t: string): CsvFileInput => ({ fileName: "a.csv", text: t, bankKey: "a", appAccountId: "acct-checking" });
    // First import: unconfirmed -> review.
    const plan1 = await planImport(repos2, [f(csv2(['10/15/2026,-150.00,,,"ONLINE TRANSFER TO SIDIBE M WAY2SAVE SAVINGS"']))]);
    const sum1 = await commitImport(repos2, plan1, [f("")]);
    expect(sum1.needsReview).toBe(1);
    // Confirm with "always".
    const { confirmTransferPair } = await import("../src/app/reviewActions.js");
    await confirmTransferPair(repos2, sum1.reviewItemIds[0] as string, true);
    // Second import, same pair, different day: no review.
    const plan2 = await planImport(repos2, [f(csv2(['10/20/2026,-200.00,,,"ONLINE TRANSFER TO SIDIBE M WAY2SAVE SAVINGS"']))]);
    const sum2 = await commitImport(repos2, plan2, [f("")]);
    expect(sum2.transfersNew).toBe(1);
    expect(sum2.needsReview).toBe(0);
    expect((await repos2.transactions.getAll()).filter((t) => t.type === "Transfer")).toHaveLength(2);
  });

  it("records a transfer to an external account via review", async () => {
    await setup2();
    const { markTransferReviewItem } = await import("../src/app/reviewActions.js");
    const { EXTERNAL_ACCOUNT_ID } = await import("../src/domain/import/selfTransfers.js");
    const f = (t: string): CsvFileInput => ({ fileName: "a.csv", text: t, bankKey: "a", appAccountId: "acct-checking" });
    const plan = await planImport(repos2, [f(csv2(['10/15/2026,-500.00,,,"ONLINE TRANSFER TO SIDIBE M UNKNOWN BANK"']))]);
    const sum = await commitImport(repos2, plan, [f("")]);
    expect(sum.needsReview).toBe(1);
    await markTransferReviewItem(repos2, sum.reviewItemIds[0] as string, EXTERNAL_ACCOUNT_ID);
    const tx = (await repos2.transactions.getAll())[0];
    expect(tx).toMatchObject({ type: "Transfer", transferToAccountId: "external", categoryId: null });
  });
});

describe("importEngine recurring detection (B2)", () => {
  let db3: MoneyTrackerDB;
  let repos3: Repositories;

  afterEach(async () => {
    await db3?.delete();
  });

  async function setup3() {
    db3 = new MoneyTrackerDB(`test-eng3-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    repos3 = createRepositories(db3);
    await repos3.accounts.put(mkAccount({ id: "acct-checking", name: "Checking", type: "Checking" }));
    await repos3.categories.put(mkCategory({ id: "cat-music", name: "Music", kind: "expense" }));
    await repos3.categories.put(mkCategory({ id: "cat-other", name: "Other", kind: "expense" }));
    await repos3.categories.put(mkCategory({ id: "cat-income", name: "Income", kind: "income" }));
    await repos3.settings.save({
      id: "settings",
      baseCurrency: "USD",
      bufferAmount: 0,
      theme: "system",
      notificationsEnabled: false,
      onboardingCompleted: true,
    } as never);
  }

  it("auto-creates a subscription rule from imported history", async () => {
    await setup3();
    const text = ["Date,Amount,*,*,Description",
      '08/15/2026,-12.99,,,"RECURRING PAYMENT AUTHORIZED ON 08/14 SPOTIFY USA"',
      '09/15/2026,-12.99,,,"RECURRING PAYMENT AUTHORIZED ON 09/14 SPOTIFY USA"',
      '10/15/2026,-12.99,,,"RECURRING PAYMENT AUTHORIZED ON 10/14 SPOTIFY USA"',
    ].join("\n");
    const f: CsvFileInput = { fileName: "a.csv", text, bankKey: "a", appAccountId: "acct-checking" };
    const plan = await planImport(repos3, [f]);
    const summary = await commitImport(repos3, plan, [f]);
    expect(summary.recurring.created).toHaveLength(1);
    expect(summary.recurring.created[0]?.message).toContain("Now tracking Spotify, $12.99 monthly");
    const rules = await repos3.recurringRules.getAll();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.kind).toBe("Subscription");
    // Past charges tagged.
    const tagged = await repos3.transactions.byRecurringRule(rules[0]!.id);
    expect(tagged).toHaveLength(3);
  });
});

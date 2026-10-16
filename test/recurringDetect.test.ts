/**
 * Phase B2 tests: auto rule creation, tagging, undo, and change flags.
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { MoneyTrackerDB } from "../src/data/db.js";
import { createRepositories, type Repositories } from "../src/data/repositories/index.js";
import {
  detectAndCreateRules,
  undoRecurringRule,
} from "../src/app/recurringDetect.js";
import {
  applyPriceIncrease,
  confirmRecurringSuggestion,
  resolveMissedCharge,
  resolveResurrected,
} from "../src/app/reviewActions.js";
import { mkAccount, mkCategory, mkTransaction } from "./helpers.js";

const NOW = "2026-10-16T12:00:00.000Z";

describe("recurringDetect", () => {
  let db: MoneyTrackerDB;
  let repos: Repositories;

  afterEach(async () => {
    await db?.delete();
  });

  async function setup() {
    db = new MoneyTrackerDB(`test-b2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    repos = createRepositories(db);
    await repos.accounts.put(mkAccount({ id: "acct-checking", name: "Checking", type: "Checking" }));
    await repos.categories.put(mkCategory({ id: "cat-music", name: "Music", kind: "expense" }));
    await repos.categories.put(mkCategory({ id: "cat-util", name: "Utilities", kind: "expense" }));
    await repos.categories.put(mkCategory({ id: "cat-other", name: "Other", kind: "expense" }));
    await repos.settings.save({
      id: "settings",
      baseCurrency: "USD",
      bufferAmount: 0,
      theme: "system",
      notificationsEnabled: false,
      onboardingCompleted: true,
    } as never);
  }

  async function addCharge(id: string, date: string, amount: number, payee: string, categoryId = "cat-music") {
    await repos.transactions.put(
      mkTransaction({ id, accountId: "acct-checking", date: date as never, amount, payee, categoryId, status: "Cleared" }),
    );
  }

  it("auto-creates a subscription rule and tags past charges", async () => {
    await setup();
    await addCharge("s1", "2026-07-15", 1299, "Spotify");
    await addCharge("s2", "2026-08-15", 1299, "Spotify");
    await addCharge("s3", "2026-09-15", 1299, "Spotify");
    await addCharge("s4", "2026-10-15", 1299, "Spotify");

    const outcome = await detectAndCreateRules(repos, [], "2026-10-16" as never);
    expect(outcome.created).toHaveLength(1);
    expect(outcome.created[0]?.message).toBe("Now tracking Spotify, $12.99 monthly, since July 2026");

    const rules = await repos.recurringRules.getAll();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      kind: "Subscription",
      name: "Spotify",
      amount: 1299,
      frequency: "monthly",
      autoCreated: true,
      merchantKey: "SPOTIFY",
      active: true,
    });
    // All past charges tagged.
    for (const id of ["s1", "s2", "s3", "s4"]) {
      expect((await repos.transactions.getById(id))?.recurringRuleId).toBe(rules[0]?.id);
    }
  });

  it("creates a Bill for varying amounts with the recent average", async () => {
    await setup();
    await addCharge("c1", "2026-07-10", 6020, "Con Edison", "cat-util");
    await addCharge("c2", "2026-08-10", 9544, "Con Edison", "cat-util");
    await addCharge("c3", "2026-09-10", 7210, "Con Edison", "cat-util");
    await addCharge("c4", "2026-10-10", 11032, "Con Edison", "cat-util");

    const outcome = await detectAndCreateRules(repos, [], "2026-10-16" as never);
    expect(outcome.created).toHaveLength(1);
    const rule = (await repos.recurringRules.getAll())[0];
    expect(rule).toMatchObject({ kind: "Bill", isVariableAmount: true });
    expect(rule?.amount).toBe(Math.round((9544 + 7210 + 11032) / 3));
  });

  it("sends a weak two-charge pattern to review, not auto-create", async () => {
    await setup();
    await addCharge("w1", "2026-09-15", 1299, "Spotify");
    await addCharge("w2", "2026-10-15", 1299, "Spotify");

    const outcome = await detectAndCreateRules(repos, [], "2026-10-16" as never);
    expect(outcome.created).toHaveLength(0);
    expect(outcome.suggested).toBe(1);
    expect(await repos.recurringRules.getAll()).toHaveLength(0);
    const reviews = await repos.reviewItems.open();
    expect(reviews.some((r) => r.reasons.includes("weak-recurring"))).toBe(true);
  });

  it("confirming a two-charge suggestion creates the rule", async () => {
    await setup();
    await addCharge("w1", "2026-09-15", 1299, "Spotify");
    await addCharge("w2", "2026-10-15", 1299, "Spotify");
    await detectAndCreateRules(repos, [], "2026-10-16" as never);
    const suggestion = (await repos.reviewItems.open()).find((r) =>
      r.reasons.includes("weak-recurring"),
    );
    expect(suggestion).toBeTruthy();
    const message = await confirmRecurringSuggestion(repos, suggestion!.id);
    expect(message).toContain("Now tracking Spotify");
    expect((await repos.recurringRules.getAll())).toHaveLength(1);
  });

  it("confirming a suggestion creates the rule", async () => {
    await setup();
    await addCharge("w1", "2026-08-15", 1299, "Spotify");
    await addCharge("w2", "2026-09-15", 1299, "Spotify");
    await addCharge("w3", "2026-10-15", 1299, "Spotify");
    // Two-charge strength is "suggest"; force the suggestion path by
    // removing one charge from detection (only 2 untagged).
    await repos.transactions.remove("w1");
    await detectAndCreateRules(repos, [], "2026-10-16" as never);
    const suggestion = (await repos.reviewItems.open()).find((r) =>
      r.reasons.includes("weak-recurring"),
    );
    expect(suggestion).toBeTruthy();
    // A third charge arrives; confirming the suggestion still needs 3.
    await addCharge("w4", "2026-11-15", 1299, "Spotify");
    const message = await confirmRecurringSuggestion(repos, suggestion!.id);
    expect(message).toContain("Now tracking Spotify");
    expect((await repos.recurringRules.getAll())).toHaveLength(1);
  });

  it("undo removes the rule and tags but never deletes transactions", async () => {
    await setup();
    await addCharge("s1", "2026-08-15", 1299, "Spotify");
    await addCharge("s2", "2026-09-15", 1299, "Spotify");
    await addCharge("s3", "2026-10-15", 1299, "Spotify");
    // A future Scheduled row from the rule.
    const outcome = await detectAndCreateRules(repos, [], "2026-10-16" as never);
    const ruleId = outcome.created[0]!.ruleId;
    await repos.transactions.put(
      mkTransaction({
        id: "sched-1",
        accountId: "acct-checking",
        date: "2026-11-15" as never,
        amount: 1299,
        payee: "Spotify",
        categoryId: "cat-music",
        status: "Scheduled",
        recurringRuleId: ruleId,
        occurrenceDate: "2026-11-15" as never,
      }),
    );

    const { untagged, removedScheduled } = await undoRecurringRule(repos, ruleId);
    expect(untagged).toBe(3);
    expect(removedScheduled).toBe(1);
    expect(await repos.recurringRules.getById(ruleId)).toBeUndefined();
    // Transactions kept, tags cleared.
    for (const id of ["s1", "s2", "s3"]) {
      const tx = await repos.transactions.getById(id);
      expect(tx).toBeTruthy();
      expect(tx?.recurringRuleId).toBeUndefined();
    }
    expect(await repos.transactions.getById("sched-1")).toBeUndefined();
    // Won't be recreated on the next run.
    const outcome2 = await detectAndCreateRules(repos, [], "2026-10-16" as never);
    expect(outcome2.created).toHaveLength(0);
  });

  it("flags a price increase", async () => {
    await setup();
    await addCharge("s1", "2026-08-15", 1299, "Spotify");
    await addCharge("s2", "2026-09-15", 1299, "Spotify");
    await addCharge("s3", "2026-10-15", 1299, "Spotify");
    await detectAndCreateRules(repos, [], "2026-10-16" as never);

    await addCharge("s4", "2026-11-15", 1599, "Spotify");
    const tx4 = (await repos.transactions.getById("s4"))!;
    const outcome = await detectAndCreateRules(repos, [tx4], "2026-11-16" as never);
    expect(outcome.flagged).toBe(1);
    const reviews = await repos.reviewItems.open();
    const flag = reviews.find((r) => r.reasons.includes("price-increase"));
    expect(flag?.guess.billName).toContain("rose to $15.99 (was $12.99)");

    await applyPriceIncrease(repos, flag!.id);
    const rule = (await repos.recurringRules.getAll())[0];
    expect(rule?.amount).toBe(1599);
  });

  it("ends a rule on a missed charge and flags it", async () => {
    await setup();
    await addCharge("s1", "2026-06-15", 1299, "Spotify");
    await addCharge("s2", "2026-07-15", 1299, "Spotify");
    await addCharge("s3", "2026-08-15", 1299, "Spotify");
    // Today is 2026-10-16; expected 2026-09-15 never arrived.
    const outcome = await detectAndCreateRules(repos, [], "2026-10-16" as never);
    expect(outcome.created).toHaveLength(1);
    expect(outcome.flagged).toBe(1);

    const rule = (await repos.recurringRules.getAll())[0];
    expect(rule?.active).toBe(false);
    expect(rule?.endDate).toBe("2026-09-15");
    const reviews = await repos.reviewItems.open();
    expect(reviews.some((r) => r.reasons.includes("missed-charge"))).toBe(true);
  });

  it("reactivating a missed charge turns the rule back on", async () => {
    await setup();
    await addCharge("s1", "2026-06-15", 1299, "Spotify");
    await addCharge("s2", "2026-07-15", 1299, "Spotify");
    await addCharge("s3", "2026-08-15", 1299, "Spotify");
    await detectAndCreateRules(repos, [], "2026-10-16" as never);
    const flag = (await repos.reviewItems.open()).find((r) => r.reasons.includes("missed-charge"));
    await resolveMissedCharge(repos, flag!.id, true);
    const rule = (await repos.recurringRules.getAll())[0];
    expect(rule?.active).toBe(true);
  });

  it("flags a new charge from a previously ended merchant", async () => {
    await setup();
    await addCharge("s1", "2026-06-15", 1299, "Spotify");
    await addCharge("s2", "2026-07-15", 1299, "Spotify");
    await addCharge("s3", "2026-08-15", 1299, "Spotify");
    await detectAndCreateRules(repos, [], "2026-10-16" as never); // ends the rule (missed Sept)

    await addCharge("s4", "2026-10-20", 1299, "Spotify");
    const tx4 = (await repos.transactions.getById("s4"))!;
    const outcome = await detectAndCreateRules(repos, [tx4], "2026-10-21" as never);
    const reviews = await repos.reviewItems.open();
    expect(reviews.some((r) => r.reasons.includes("resurrected-merchant"))).toBe(true);

    const flag = reviews.find((r) => r.reasons.includes("resurrected-merchant"))!;
    await resolveResurrected(repos, flag.id, true);
    const rule = (await repos.recurringRules.getAll())[0];
    expect(rule?.active).toBe(true);
    expect((await repos.transactions.getById("s4"))?.recurringRuleId).toBe(rule?.id);
  });

  it("does not recreate a rule for a dismissed merchant", async () => {
    await setup();
    await addCharge("s1", "2026-08-15", 1299, "Spotify");
    await addCharge("s2", "2026-09-15", 1299, "Spotify");
    await detectAndCreateRules(repos, [], "2026-10-16" as never); // suggestion
    const suggestion = (await repos.reviewItems.open()).find((r) =>
      r.reasons.includes("weak-recurring"),
    );
    const { ignoreReviewItem } = await import("../src/app/reviewActions.js");
    await ignoreReviewItem(repos, suggestion!.id);
    await addCharge("s3", "2026-11-15", 1299, "Spotify");
    const outcome = await detectAndCreateRules(repos, [], "2026-11-16" as never);
    expect(outcome.created).toHaveLength(0);
    expect(outcome.suggested).toBe(0);
  });
});

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

  async function addImportedCharge(
    id: string,
    date: string,
    amount: number,
    payee: string,
    batchId: string,
    categoryId = "cat-music",
  ) {
    await repos.transactions.put(
      mkTransaction({
        id,
        accountId: "acct-checking",
        date: date as never,
        amount,
        payee,
        categoryId,
        status: "Cleared",
        importBatchId: batchId,
      }),
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
    // Data runs through Aug 18: the Sep 15 charge isn't missed yet, the
    // data just ends. Missed is measured against the data, not today.
    await addCharge("x1", "2026-08-18", 5000, "Whole Foods");
    const first = await detectAndCreateRules(repos, [], "2026-08-19" as never);
    expect(first.created).toHaveLength(1);
    expect(first.flagged).toBe(0);
    expect((await repos.recurringRules.getAll())[0]?.active).toBe(true);

    // Data now runs through Oct 10 with no Sep 15 charge: actually missed.
    await addCharge("x2", "2026-10-10", 4200, "Whole Foods");
    const outcome = await detectAndCreateRules(repos, [], "2026-10-16" as never);
    expect(outcome.created).toHaveLength(0);
    expect(outcome.flagged).toBe(1);

    const rule = (await repos.recurringRules.getAll())[0];
    expect(rule?.active).toBe(false);
    expect(rule?.endDate).toBe("2026-09-15");
    const reviews = await repos.reviewItems.open();
    expect(reviews.some((r) => r.reasons.includes("missed-charge"))).toBe(true);
  });

  it("importing an older CSV never ends an active rule", async () => {
    await setup();
    await addCharge("s1", "2026-08-15", 1299, "Spotify");
    await addCharge("s2", "2026-09-15", 1299, "Spotify");
    await addCharge("s3", "2026-10-15", 1299, "Spotify");
    const first = await detectAndCreateRules(repos, [], "2026-10-16" as never);
    expect(first.created).toHaveLength(1);

    // A stale historical import arrives; every row predates the rule.
    // The reference date stays at Oct 15 (the newest data), so the rule
    // is untouched.
    await addCharge("old1", "2026-03-10", 2500, "Trader Joes");
    await addCharge("old2", "2026-05-25", 3100, "Trader Joes");
    const second = await detectAndCreateRules(repos, [], "2026-10-16" as never);
    expect(second.flagged).toBe(0);
    const rule = (await repos.recurringRules.getAll())[0];
    expect(rule?.active).toBe(true);
  });

  it("creates a long-dead pattern as an ended rule with no fanfare", async () => {
    await setup();
    await addCharge("s1", "2026-03-15", 1299, "Spotify");
    await addCharge("s2", "2026-04-15", 1299, "Spotify");
    await addCharge("s3", "2026-05-15", 1299, "Spotify");
    // The data runs through October: this pattern died in June.
    await addCharge("x1", "2026-10-10", 5000, "Whole Foods");

    const outcome = await detectAndCreateRules(repos, [], "2026-10-16" as never);
    expect(outcome.created).toHaveLength(0);
    expect(outcome.pastSubscriptions).toBe(1);
    expect(outcome.flagged).toBe(0);

    const rules = await repos.recurringRules.getAll();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ active: false, endDate: "2026-06-15", name: "Spotify" });
    // Past charges are still tagged, so history is complete.
    for (const id of ["s1", "s2", "s3"]) {
      expect((await repos.transactions.getById(id))?.recurringRuleId).toBe(rules[0]?.id);
    }
    // No "possibly cancelled" review item.
    const reviews = await repos.reviewItems.open();
    expect(reviews.some((r) => r.reasons.includes("missed-charge"))).toBe(false);
  });

  it("treats a seasonal monthly bill as exactly one variable rule", async () => {
    await setup();
    const amounts = [8000, 8200, 8600, 9000, 12000, 14000, 15000, 14500, 11000, 8400, 8300, 8800];
    for (let m = 0; m < 12; m++) {
      const month = String(m + 1).padStart(2, "0");
      await addImportedCharge(`e${m}`, `2026-${month}-10`, amounts[m]!, "Con Edison", "batch-1", "cat-util");
    }

    const outcome = await detectAndCreateRules(repos, [], "2026-12-16" as never);
    expect(outcome.created).toHaveLength(1);
    expect(outcome.suggested).toBe(0);
    expect(outcome.pastSubscriptions).toBe(0);

    const rules = await repos.recurringRules.getAll();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      kind: "Bill",
      frequency: "monthly",
      isVariableAmount: true,
      active: true,
    });
    // Recent average of the last 3 charges.
    expect(rules[0]?.amount).toBe(Math.round((8400 + 8300 + 8800) / 3));
    // All 12 charges tagged.
    expect(await repos.transactions.byRecurringRule(rules[0]!.id)).toHaveLength(12);
  });

  it("ignores manual and Quick-Log entries when measuring the data date", async () => {
    await setup();
    // Imported CSV ending Sep 20; the monthly charge was last seen Sep 5.
    await addImportedCharge("s1", "2026-07-05", 1299, "Spotify", "batch-1");
    await addImportedCharge("s2", "2026-08-05", 1299, "Spotify", "batch-1");
    await addImportedCharge("s3", "2026-09-05", 1299, "Spotify", "batch-1");
    await addImportedCharge("x1", "2026-09-20", 5000, "Whole Foods", "batch-1");
    // A manual Quick-Log entry dated today: the user's bookkeeping, not
    // the bank's record. Must not move the reference date.
    await addCharge("m1", "2026-10-16", 2500, "Chipotle", "cat-other");

    const outcome = await detectAndCreateRules(repos, [], "2026-10-16" as never);
    expect(outcome.created).toHaveLength(1);
    expect(outcome.pastSubscriptions).toBe(0);
    const rule = (await repos.recurringRules.getAll())[0];
    expect(rule?.active).toBe(true);
  });

  it("does not create a rule from 3 weekly coffee purchases with different amounts", async () => {
    await setup();
    await addCharge("c1", "2026-09-18", 450, "Blue Bottle Coffee", "cat-other");
    await addCharge("c2", "2026-09-25", 675, "Blue Bottle Coffee", "cat-other");
    await addCharge("c3", "2026-10-02", 525, "Blue Bottle Coffee", "cat-other");

    const outcome = await detectAndCreateRules(repos, [], "2026-10-16" as never);
    expect(outcome.created).toHaveLength(0);
    expect(outcome.suggested).toBe(0);
    expect(await repos.recurringRules.getAll()).toHaveLength(0);
  });

  it("weekly patterns need 4 similar charges to auto-create", async () => {
    await setup();
    await addCharge("w1", "2026-09-18", 500, "Blue Bottle Coffee", "cat-other");
    await addCharge("w2", "2026-09-25", 500, "Blue Bottle Coffee", "cat-other");
    await addCharge("w3", "2026-10-02", 500, "Blue Bottle Coffee", "cat-other");

    const first = await detectAndCreateRules(repos, [], "2026-10-16" as never);
    expect(first.created).toHaveLength(0);
    expect(first.suggested).toBe(1);

    await addCharge("w4", "2026-10-09", 500, "Blue Bottle Coffee", "cat-other");
    const second = await detectAndCreateRules(repos, [], "2026-10-16" as never);
    expect(second.created).toHaveLength(1);
    expect(second.created[0]?.message).toContain("weekly");
  });

  it("groups fixed-amount charges within 10% into one stream", async () => {
    await setup();
    await addCharge("s1", "2026-08-15", 1299, "Spotify");
    await addCharge("s2", "2026-09-15", 1349, "Spotify"); // small bump, same stream
    await addCharge("s3", "2026-10-15", 1299, "Spotify");

    const outcome = await detectAndCreateRules(repos, [], "2026-10-16" as never);
    expect(outcome.created).toHaveLength(1);
    const rule = (await repos.recurringRules.getAll())[0];
    expect(rule?.amount).toBe(Math.round((1299 + 1349 + 1299) / 3));
  });

  it("detects separate amount-streams from one merchant as separate rules", async () => {
    await setup();
    // iCloud+ $2.99 and Apple One $10.99, interleaved monthly.
    await addCharge("a1", "2026-08-15", 299, "Apple");
    await addCharge("b1", "2026-08-20", 1099, "Apple");
    await addCharge("a2", "2026-09-15", 299, "Apple");
    await addCharge("b2", "2026-09-20", 1099, "Apple");
    await addCharge("a3", "2026-10-15", 299, "Apple");
    await addCharge("b3", "2026-10-20", 1099, "Apple");

    const outcome = await detectAndCreateRules(repos, [], "2026-10-21" as never);
    expect(outcome.created).toHaveLength(2);

    const rules = await repos.recurringRules.getAll();
    expect(rules).toHaveLength(2);
    expect(rules.map((r) => r.amount).sort((a, b) => a - b)).toEqual([299, 1099]);
    expect(rules.every((r) => r.kind === "Subscription" && r.frequency === "monthly")).toBe(true);

    // A re-run creates nothing: both streams are already tracked.
    const again = await detectAndCreateRules(repos, [], "2026-10-21" as never);
    expect(again.created).toHaveLength(0);
    expect((await repos.recurringRules.getAll())).toHaveLength(2);
  });

  it("reactivating a missed charge turns the rule back on", async () => {
    await setup();
    await addCharge("s1", "2026-06-15", 1299, "Spotify");
    await addCharge("s2", "2026-07-15", 1299, "Spotify");
    await addCharge("s3", "2026-08-15", 1299, "Spotify");
    await addCharge("x1", "2026-08-18", 5000, "Whole Foods");
    await detectAndCreateRules(repos, [], "2026-08-19" as never);
    await addCharge("x2", "2026-10-10", 4200, "Whole Foods");
    await detectAndCreateRules(repos, [], "2026-10-16" as never);
    const flag = (await repos.reviewItems.open()).find((r) => r.reasons.includes("missed-charge"));
    expect(flag).toBeTruthy();
    await resolveMissedCharge(repos, flag!.id, true);
    const rule = (await repos.recurringRules.getAll())[0];
    expect(rule?.active).toBe(true);
  });

  it("flags a new charge from a previously ended merchant", async () => {
    await setup();
    await addCharge("s1", "2026-06-15", 1299, "Spotify");
    await addCharge("s2", "2026-07-15", 1299, "Spotify");
    await addCharge("s3", "2026-08-15", 1299, "Spotify");
    await addCharge("x1", "2026-08-18", 5000, "Whole Foods");
    await detectAndCreateRules(repos, [], "2026-08-19" as never); // rule active
    await addCharge("x2", "2026-10-01", 4100, "Whole Foods");
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

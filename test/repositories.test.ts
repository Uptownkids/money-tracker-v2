/** Dexie repository round-trip tests (fake-indexeddb). */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { MoneyTrackerDB } from "../src/data/db.js";
import { createRepositories } from "../src/data/repositories/index.js";
import { mkAccount, mkGoal, mkRule, mkTransaction } from "./helpers.js";

describe("repositories", () => {
  let db: MoneyTrackerDB;
  afterEach(async () => {
    await db?.delete();
  });

  it("round-trips accounts, transactions, and rules", async () => {
    db = new MoneyTrackerDB(`test-${Date.now()}`);
    const repos = createRepositories(db);

    const acct = mkAccount({ id: "a1", name: "Checking" });
    await repos.accounts.put(acct);
    expect(await repos.accounts.getById("a1")).toMatchObject({ name: "Checking" });
    expect(await repos.accounts.active()).toHaveLength(1);

    const tx = mkTransaction({
      id: "t1",
      accountId: "a1",
      date: "2026-10-15",
      status: "Scheduled",
      recurringRuleId: "r1",
      occurrenceDate: "2026-10-15",
    });
    await repos.transactions.put(tx);
    expect(await repos.transactions.byRuleOccurrence("r1", "2026-10-15")).toMatchObject({ id: "t1" });
    expect(await repos.transactions.byStatus("Scheduled")).toHaveLength(1);
    expect(await repos.transactions.byDateRange("2026-10-01", "2026-10-31")).toHaveLength(1);
    expect(await repos.transactions.byDateRange("2026-11-01", "2026-11-30")).toHaveLength(0);

    const rule = mkRule({ id: "r1", active: true });
    await repos.recurringRules.put(rule);
    expect(await repos.recurringRules.active()).toHaveLength(1);

    const goal = mkGoal({ id: "g1", paused: false });
    await repos.goals.put(goal);
    expect(await repos.goals.active()).toHaveLength(1);

    await repos.settings.save({ id: "settings", baseCurrency: "USD", bufferAmount: 0, theme: "system", notificationsEnabled: true, onboardingCompleted: true });
    expect(await repos.settings.get()).toMatchObject({ baseCurrency: "USD" });

    await db.delete();
  });
});

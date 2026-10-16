/** Dexie schema upgrades: v2 -> v3 keeps data and adds import stores. */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import Dexie from "dexie";
import { MoneyTrackerDB } from "../src/data/db.js";
import { createRepositories } from "../src/data/repositories/index.js";
import { mkAccount } from "./helpers.js";

describe("db v2 -> v3 upgrade", () => {
  let name = "";
  afterEach(async () => {
    if (name) await Dexie.delete(name);
  });

  it("upgrades a v2 database in place, preserving data", async () => {
    name = `test-upgrade-${Date.now()}`;
    // Build a v2-shaped database with one account.
    const v2 = new Dexie(name) as Dexie;
    v2.version(2).stores({
      accounts: "id, archived",
      categories: "id, kind",
      transactions: "id, date, accountId, categoryId, status, recurringRuleId, [recurringRuleId+occurrenceDate], goalId",
      recurringRules: "id, nextDueDate, kind, active, lastGeneratedThrough",
      recurringOverrides: "id, ruleId, [ruleId+occurrenceDate]",
      goals: "id, paused, targetDate",
      splits: "id, settled, person",
      settings: "id",
      paydayRuns: "id, payDate, completed",
      dailySnapshots: "id, date",
      snoozedMoves: "moveId",
    });
    await v2.table("accounts").put(mkAccount({ id: "a1", name: "Checking" }));
    await v2.close();

    // Open with the real DB class: Dexie runs the v2 -> v3 upgrade.
    const db = new MoneyTrackerDB(name);
    const repos = createRepositories(db);
    expect(await repos.accounts.getById("a1")).toMatchObject({ name: "Checking" });

    // New stores exist and are usable.
    await repos.importBatches.put({
      id: "b1",
      createdAt: "2026-10-16T00:00:00.000Z",
      fileNames: ["a.csv"],
      stats: { rows: 1, imported: 1, duplicates: 0 },
      status: "committed",
    });
    expect(await repos.importBatches.getById("b1")).toMatchObject({ status: "committed" });
    await repos.bankAccountMaps.put({
      id: "m1",
      bankKey: "wf-checking",
      appAccountId: "a1",
      createdAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.000Z",
    });
    expect((await repos.bankAccountMaps.getAll())).toHaveLength(1);
    await db.close();
  });
});

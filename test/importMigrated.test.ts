/** Atomic import: one Dexie transaction, real rollback on failure. */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoneyTrackerDB } from "../src/data/db.js";
import { migrateFromV1, type MigrationResult, type V1Dashboard } from "../src/data/migration/fromV1.js";
import { importMigratedResult } from "../src/data/migration/importMigrated.js";
import type { Settings } from "../src/domain/entities/settings.js";

const NOW = "2026-10-15T12:00:00.000Z";

function v1Dashboard(): V1Dashboard {
  return {
    bills: [{ id: 1, name: "Rent", amount: 1350, due_day: null }],
    debts: [{ id: 1, name: "Concord", current_balance: 1488.35, minimum_payment: 264, due_day: 11, due_label: "Due Oct 11" }],
    expenses: [{ id: 12, amount: 16.34, category: "Food", expense_date: "2026-10-14", note: "Lunch" }],
    settings: {
      current_cash: 13,
      savings_per_paycheck: 150,
      savings_goal: 10000,
      paycheck_amount: 2263.41,
      payday_one: 15,
      payday_two: 30,
    },
    savings_total: 0,
    trip_expenses: [{ id: 20, amount: 570, category: "Other", expense_date: "2026-10-14", note: "LA float" }],
    bill_payments: [],
  };
}

function migrated(): MigrationResult {
  return migrateFromV1(v1Dashboard(), {
    migrationDate: "2026-10-15",
    nowIso: NOW,
    tripGoal: { targetDate: "2026-10-22", setAsideMinor: 20000 },
  });
}

const TABLE_COUNT = 7;

async function tableCounts(db: MoneyTrackerDB): Promise<number[]> {
  return Promise.all([
    db.accounts.count(),
    db.categories.count(),
    db.transactions.count(),
    db.recurringRules.count(),
    db.goals.count(),
    db.splits.count(),
    db.settings.count(),
  ]);
}

describe("importMigratedResult", () => {
  let dbs: MoneyTrackerDB[] = [];
  const freshDb = (): MoneyTrackerDB => {
    const db = new MoneyTrackerDB(`import-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    dbs.push(db);
    return db;
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dbs.map((db) => db.delete().catch(() => {})));
    dbs = [];
  });

  it("populates all seven tables and completes onboarding on the happy path", async () => {
    const db = freshDb();
    const m = migrated();
    await importMigratedResult(db, m);

    const counts = await tableCounts(db);
    expect(counts).toHaveLength(TABLE_COUNT);
    expect(await db.accounts.count()).toBe(m.accounts.length);
    expect(await db.categories.count()).toBe(m.categories.length);
    expect(await db.transactions.count()).toBe(m.transactions.length);
    expect(await db.recurringRules.count()).toBe(m.recurringRules.length);
    expect(await db.goals.count()).toBe(m.goals.length);
    expect(await db.splits.count()).toBe(m.splits.length);

    const settings = await db.settings.get("settings");
    expect(settings?.onboardingCompleted).toBe(true);

    // the trip goal and its earmarked self-transfer made it in
    const tripGoal = (await db.goals.toArray()).find((g) => g.name === "LA trip float")!;
    expect(tripGoal.targetAmount).toBe(57000);
    const earmarked = await db.transactions.where("goalId").equals(tripGoal.id).toArray();
    expect(earmarked).toHaveLength(1);
    expect(earmarked[0]!.amount).toBe(20000);
    expect(earmarked[0]!.accountId).toBe(earmarked[0]!.transferToAccountId);
  });

  it("merges the onboarding flag onto existing settings instead of wiping them", async () => {
    const db = freshDb();
    const existing: Settings = {
      id: "settings",
      baseCurrency: "USD",
      bufferAmount: 0,
      theme: "dark",
      notificationsEnabled: true,
      onboardingCompleted: false,
    };
    await db.settings.put(existing);
    await importMigratedResult(db, migrated());

    const settings = await db.settings.get("settings");
    expect(settings?.onboardingCompleted).toBe(true);
    expect(settings?.theme).toBe("dark");
    expect(settings?.notificationsEnabled).toBe(true);
  });

  it("rolls back everything when a write fails mid-import", async () => {
    const db = freshDb();
    const m = migrated();
    vi.spyOn(db.goals, "bulkPut").mockRejectedValueOnce(new Error("boom"));

    await expect(importMigratedResult(db, m)).rejects.toThrow("boom");

    // real rollback: all seven tables are empty, not just error propagation
    expect(await tableCounts(db)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

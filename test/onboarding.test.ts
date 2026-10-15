/**
 * Onboarding Track 2 tests: gate logic, v1 shape validation,
 * reconciliation diffs, flag completion, and the fresh-wizard writer.
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { getDb, getDemoDb, isDemoMode, setDemoMode } from "../src/data/db.js";
import { createRepositories } from "../src/data/repositories/index.js";
import { migrateFromV1, type V1Dashboard } from "../src/data/migration/fromV1.js";
import {
  markOnboardingComplete,
  realRepositories,
  reconciliationDiffs,
  shouldShowOnboarding,
  validateV1Shape,
  writeFreshOnboarding,
} from "../src/app/onboarding.js";
import type { Settings } from "../src/domain/entities/settings.js";
import { mkAccount } from "./helpers.js";

const NOW = "2026-10-15T12:00:00.000Z";

function v1Dashboard(): V1Dashboard {
  return {
    bills: [
      { id: 1, name: "Rent", amount: 1350, due_day: null },
      { id: 2, name: "Internet", amount: 62, due_day: null },
      { id: 3, name: "Phone", amount: 110, due_day: null },
    ],
    debts: [
      { id: 1, name: "Concord", current_balance: 1488.35, minimum_payment: 264, due_day: 11, due_label: "Due Oct 11" },
      { id: 2, name: "Credit One", current_balance: 934.92, minimum_payment: 47, due_day: null, due_label: "Due now" },
      { id: 3, name: "Aspire", current_balance: 485.6, minimum_payment: 321.91, due_day: 28, due_label: "Due Oct 28" },
    ],
    expenses: [
      { id: 12, amount: 16.34, category: "Food", expense_date: "2026-10-14", note: "Lunch" },
      { id: 13, amount: 10.5, category: "Coffee", expense_date: "2026-10-13", note: "Morning coffee" },
    ],
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

function baseSettings(partial: Partial<Settings> = {}): Settings {
  return {
    id: "settings",
    baseCurrency: "USD",
    bufferAmount: 0,
    theme: "system",
    notificationsEnabled: false,
    onboardingCompleted: false,
    ...partial,
  };
}

describe("shouldShowOnboarding", () => {
  it("shows when the flag is unset and the database is empty", () => {
    expect(shouldShowOnboarding(baseSettings(), 0)).toBe(true);
  });

  it("shows when settings are missing entirely and the database is empty", () => {
    expect(shouldShowOnboarding(undefined, 0)).toBe(true);
    expect(shouldShowOnboarding(null, 0)).toBe(true);
  });

  it("hides when the flag is set, even with no accounts", () => {
    expect(shouldShowOnboarding(baseSettings({ onboardingCompleted: true }), 0)).toBe(false);
  });

  it("hides when accounts exist, even with the flag unset (existing users)", () => {
    expect(shouldShowOnboarding(baseSettings(), 3)).toBe(false);
    expect(shouldShowOnboarding(undefined, 1)).toBe(false);
  });

  it("hides when both flag and accounts are present", () => {
    expect(shouldShowOnboarding(baseSettings({ onboardingCompleted: true }), 5)).toBe(false);
  });
});

describe("validateV1Shape", () => {
  it("accepts the v1Dashboard fixture shape", () => {
    expect(validateV1Shape(v1Dashboard())).toEqual({ ok: true });
  });

  it("rejects non-objects with a named error", () => {
    for (const bad of [null, undefined, [], "{}", 42]) {
      const res = validateV1Shape(bad);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.join(" ")).toContain("v1 backup");
      }
    }
  });

  it("names each missing list key", () => {
    const v1 = v1Dashboard() as unknown as Record<string, unknown>;
    delete v1.debts;
    delete v1.bill_payments;
    const res = validateV1Shape(v1);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.includes('"debts"'))).toBe(true);
      expect(res.errors.some((e) => e.includes('"bill_payments"'))).toBe(true);
      expect(res.errors.some((e) => e.includes('"bills"'))).toBe(false);
    }
  });

  it("rejects a non-object settings section and a non-numeric savings_total", () => {
    const v1 = v1Dashboard() as unknown as Record<string, unknown>;
    v1.settings = "nope";
    v1.savings_total = "13";
    const res = validateV1Shape(v1);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.includes('"settings"'))).toBe(true);
      expect(res.errors.some((e) => e.includes('"savings_total"'))).toBe(true);
    }
  });

  it("rejects non-numeric settings numbers and unnamed debts", () => {
    const v1 = v1Dashboard() as unknown as Record<string, unknown>;
    (v1.settings as Record<string, unknown>).current_cash = "lots";
    (v1.debts as unknown[]).push({ id: 9, current_balance: "???" });
    const res = validateV1Shape(v1);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.includes("settings.current_cash"))).toBe(true);
      expect(res.errors.some((e) => e.includes("debts[3]"))).toBe(true);
    }
  });

  it("rejects wrong-typed lists", () => {
    const v1 = v1Dashboard() as unknown as Record<string, unknown>;
    v1.expenses = { not: "a list" };
    const res = validateV1Shape(v1);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.includes('"expenses"'))).toBe(true);
    }
  });
});

describe("reconciliationDiffs", () => {
  it("is all zeros on a matching in-memory migration", () => {
    const v1 = v1Dashboard();
    const migrated = migrateFromV1(v1, { migrationDate: "2026-10-15", nowIso: NOW });
    const rows = reconciliationDiffs(v1, migrated);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.diffMinor).toBe(0);
    }
    // cash + one row per debt
    expect(rows.map((r) => r.label)).toEqual(["Cash", "Concord", "Credit One", "Aspire"]);
    // v1 debts show positive (owed); v2 liabilities store negative
    const concord = rows.find((r) => r.label === "Concord")!;
    expect(concord.v1Minor).toBe(148835);
    expect(concord.v2Minor).toBe(-148835);
  });

  it("includes a Savings row when savings_total is positive", () => {
    const v1 = v1Dashboard();
    v1.savings_total = 2250;
    const migrated = migrateFromV1(v1, { migrationDate: "2026-10-15", nowIso: NOW });
    const rows = reconciliationDiffs(v1, migrated);
    const savings = rows.find((r) => r.label === "Savings")!;
    expect(savings.v1Minor).toBe(225000);
    expect(savings.v2Minor).toBe(225000);
    expect(savings.diffMinor).toBe(0);
  });

  it("flags a nonzero diff when a migrated balance is tampered", () => {
    const v1 = v1Dashboard();
    const migrated = migrateFromV1(v1, { migrationDate: "2026-10-15", nowIso: NOW });
    const concord = migrated.accounts.find((a) => a.name === "Concord")!;
    concord.startingBalance += 1; // one cent off
    const rows = reconciliationDiffs(v1, migrated);
    const tampered = rows.find((r) => r.label === "Concord")!;
    expect(tampered.diffMinor).toBe(1);
    expect(tampered.v2Minor).toBe(-148834);
    // untouched rows still reconcile
    for (const r of rows.filter((r) => r.label !== "Concord")) {
      expect(r.diffMinor).toBe(0);
    }
  });

  it("flags a missing account as a nonzero diff", () => {
    const v1 = v1Dashboard();
    const migrated = migrateFromV1(v1, { migrationDate: "2026-10-15", nowIso: NOW });
    migrated.accounts = migrated.accounts.filter((a) => a.name !== "Aspire");
    const rows = reconciliationDiffs(v1, migrated);
    const missing = rows.find((r) => r.label === "Aspire")!;
    expect(missing.diffMinor).toBe(48560);
  });
});

describe("markOnboardingComplete", () => {
  afterEach(async () => {
    const db = getDb();
    await db
      .transaction("rw", db.tables, async () => {
        await Promise.all(db.tables.map((t) => t.clear()));
      })
      .catch(() => {});
  });

  it("creates default settings with the flag when no row exists", async () => {
    const repos = createRepositories(getDb());
    await markOnboardingComplete(repos);
    const settings = await repos.settings.get();
    expect(settings).toMatchObject({ id: "settings", onboardingCompleted: true, baseCurrency: "USD" });
  });

  it("sets the flag on the existing row and preserves its fields", async () => {
    const repos = createRepositories(getDb());
    await repos.settings.save(baseSettings({ bufferAmount: 5000, theme: "dark" }));
    await markOnboardingComplete(repos);
    const settings = await repos.settings.get();
    expect(settings).toMatchObject({
      onboardingCompleted: true,
      bufferAmount: 5000,
      theme: "dark",
      baseCurrency: "USD",
    });
  });

  it("is idempotent", async () => {
    const repos = createRepositories(getDb());
    await markOnboardingComplete(repos);
    await markOnboardingComplete(repos);
    expect((await repos.settings.get())?.onboardingCompleted).toBe(true);
  });
});

describe("writeFreshOnboarding", () => {
  afterEach(async () => {
    const db = getDb();
    await db
      .transaction("rw", db.tables, async () => {
        await Promise.all(db.tables.map((t) => t.clear()));
      })
      .catch(() => {});
  });

  it("throws when the draft has no accounts", async () => {
    const repos = createRepositories(getDb());
    await expect(
      writeFreshOnboarding(
        repos,
        { accounts: [], payday: null, bills: [], goal: null },
        { today: "2026-10-15", nowIso: NOW },
      ),
    ).rejects.toThrow("at least one account");
  });

  it("writes accounts, payday, bills, goal, and categories to the real db", async () => {
    const repos = createRepositories(getDb());
    const checkingId = "acct-checking";
    const cardId = "acct-card";
    await writeFreshOnboarding(
      repos,
      {
        accounts: [
          { id: checkingId, name: "Checking", type: "Checking", enteredMinor: 310000 },
          { id: cardId, name: "Credit One", type: "CreditCard", enteredMinor: 93492 },
        ],
        payday: { amountMinor: 226341, dates: ["2026-10-15", "2026-10-30"], frequency: "semi-monthly" },
        bills: [
          { id: "bill-rent", name: "Rent", amountMinor: 135000, nextDueDate: "2026-11-01", accountId: checkingId },
          { id: "bill-phone", name: "Phone", amountMinor: 11000, nextDueDate: "2026-11-05", accountId: checkingId },
        ],
        goal: { name: "Emergency fund", targetMinor: 1000000, targetDate: "2027-07-31" },
      },
      { today: "2026-10-15", nowIso: NOW },
    );

    const [accounts, rules, goals, categories] = await Promise.all([
      repos.accounts.getAll(),
      repos.recurringRules.getAll(),
      repos.goals.getAll(),
      repos.categories.getAll(),
    ]);

    // accounts: liabilities stored negative, spendable flags correct
    const checking = accounts.find((a) => a.id === checkingId)!;
    expect(checking.startingBalance).toBe(310000);
    expect(checking.countsAsSpendable).toBe(true);
    const card = accounts.find((a) => a.id === cardId)!;
    expect(card.startingBalance).toBe(-93492);
    expect(card.countsAsSpendable).toBe(false);

    // default categories are seeded
    expect(categories.length).toBeGreaterThan(0);
    const incomeCat = categories.find((c) => c.kind === "income")!;
    expect(incomeCat.name).toBe("Income");
    expect(categories.some((c) => c.name === "Other")).toBe(true);

    // primary payday rule
    const payday = rules.find((r) => r.isPrimaryPayday)!;
    expect(payday).toMatchObject({
      kind: "Income",
      name: "Paycheck",
      amount: 226341,
      frequency: "semi-monthly",
      accountId: checkingId,
      categoryId: incomeCat.id,
      weekendShift: "previous-business-day",
      active: true,
    });
    expect(payday.daysOfMonth).toEqual([15, 30]);
    expect(payday.nextDueDate).toBe("2026-10-15");

    // monthly bill rules
    const rent = rules.find((r) => r.name === "Rent")!;
    expect(rent).toMatchObject({
      kind: "Bill",
      amount: 135000,
      frequency: "monthly",
      nextDueDate: "2026-11-01",
      accountId: checkingId,
      active: true,
    });
    expect(rules.filter((r) => r.kind === "Bill")).toHaveLength(2);

    // goal
    const goal = goals.find((g) => g.name === "Emergency fund")!;
    expect(goal).toMatchObject({
      targetAmount: 1000000,
      targetDate: "2027-07-31",
      currency: "USD",
      priority: 1,
      paused: false,
    });
    expect(goal.pinnedContribution).toBeNull();
  });

  it("picks the checking account for the payday rule and handles a monthly payday", async () => {
    const repos = createRepositories(getDb());
    const savingsId = "acct-savings";
    const checkingId = "acct-checking-2";
    await writeFreshOnboarding(
      repos,
      {
        // checking listed second on purpose
        accounts: [
          { id: savingsId, name: "Savings", type: "Savings", enteredMinor: 225000 },
          { id: checkingId, name: "Checking", type: "Checking", enteredMinor: 50000 },
        ],
        payday: { amountMinor: 400000, dates: ["2026-11-01"], frequency: "monthly" },
        bills: [],
        goal: null,
      },
      { today: "2026-10-15", nowIso: NOW },
    );
    const rules = await repos.recurringRules.getAll();
    const payday = rules.find((r) => r.isPrimaryPayday)!;
    expect(payday.accountId).toBe(checkingId);
    expect(payday.frequency).toBe("monthly");
    expect(payday.daysOfMonth).toBeUndefined();
    expect(payday.nextDueDate).toBe("2026-11-01");
    expect(await repos.goals.getAll()).toHaveLength(0);
  });

  it("falls back to the first account for bills referencing a removed account", async () => {
    const repos = createRepositories(getDb());
    await writeFreshOnboarding(
      repos,
      {
        accounts: [{ id: "a1", name: "Cash", type: "Cash", enteredMinor: 5000 }],
        payday: null,
        bills: [{ id: "b1", name: "Rent", amountMinor: 135000, nextDueDate: "2026-11-01", accountId: "gone" }],
        goal: null,
      },
      { today: "2026-10-15", nowIso: NOW },
    );
    const rules = await repos.recurringRules.getAll();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.accountId).toBe("a1");
  });
});

describe("realRepositories", () => {
  afterEach(async () => {
    setDemoMode(false);
    for (const db of [getDb(), getDemoDb()]) {
      await db
        .transaction("rw", db.tables, async () => {
          await Promise.all(db.tables.map((t) => t.clear()));
        })
        .catch(() => {});
    }
  });

  it("switches demo mode off and binds repos to the real database", async () => {
    setDemoMode(true);
    expect(isDemoMode()).toBe(true);

    const repos = realRepositories();
    expect(isDemoMode()).toBe(false);

    await repos.accounts.put(mkAccount({ id: "real-acct", name: "Real Checking" }));

    const inReal = await getDb().accounts.get("real-acct");
    expect(inReal?.name).toBe("Real Checking");
    expect(await getDemoDb().accounts.get("real-acct")).toBeUndefined();
  });
});

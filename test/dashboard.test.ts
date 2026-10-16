/** Dashboard orchestration: snapshot refresh wiring and converter fallback. */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../src/data/db.js";
import { createRepositories } from "../src/data/repositories/index.js";
import {
  displayedCashOnHand,
  loadDashboardState,
  makeConverter,
  refreshTodaySnapshot,
} from "../src/app/dashboard.js";
import { todayLocal } from "../src/domain/dates/dateOnly.js";
import { FxRateMemory } from "../src/domain/money/fx.js";
import { mkAccount, mkTransaction } from "./helpers.js";

const SETTINGS = {
  id: "settings" as const,
  baseCurrency: "USD",
  bufferAmount: 0,
  theme: "system" as const,
  notificationsEnabled: false,
  onboardingCompleted: true,
};

describe("refreshTodaySnapshot", () => {
  afterEach(async () => {
    // Clear tables without closing: getDb() is a shared singleton.
    const db = getDb();
    await db
      .transaction("rw", db.tables, async () => {
        await Promise.all(db.tables.map((t) => t.clear()));
      })
      .catch(() => {});
  });

  it("recalculates and overwrites today's snapshot after new income lands", async () => {
    const db = getDb();
    const repos = createRepositories(db);
    const today = todayLocal();
    await repos.accounts.put(
      mkAccount({
        id: "chk",
        name: "Checking",
        type: "Checking",
        currency: "USD",
        startingBalance: 100000,
        countsAsSpendable: true,
      }),
    );
    await repos.settings.save(SETTINGS);

    const before = await loadDashboardState();
    const availableBefore = before.snapshot.available;

    // Payday confirmed: income lands in checking.
    await repos.transactions.put(
      mkTransaction({
        id: "pay-1",
        type: "Income",
        amount: 226341,
        currency: "USD",
        date: today,
        accountId: "chk",
        status: "Cleared",
      }),
    );

    const snap = await refreshTodaySnapshot();
    expect(snap.available).toBe(availableBefore + 226341);

    // The overwrite persists: a fresh load reads the refreshed snapshot.
    const after = await loadDashboardState();
    expect(after.snapshot.available).toBe(availableBefore + 226341);
  });
});

describe("displayedCashOnHand", () => {
  it("shows the full balance when the buffer is 0", () => {
    expect(displayedCashOnHand(172120, 0)).toBe(172120);
  });

  it("subtracts the buffer for display only", () => {
    expect(displayedCashOnHand(172120, 30000)).toBe(142120);
  });

  it("can go negative when the buffer exceeds the balance (honest display)", () => {
    expect(displayedCashOnHand(10000, 30000)).toBe(-20000);
  });
});

describe("safetyBuffer in loadDashboardState", () => {
  afterEach(async () => {
    const db = getDb();
    await db
      .transaction("rw", db.tables, async () => {
        await Promise.all(db.tables.map((t) => t.clear()));
      })
      .catch(() => {});
  });

  it("exposes the buffer while cashOnHand stays the real balance", async () => {
    const db = getDb();
    const repos = createRepositories(db);
    await repos.accounts.put(
      mkAccount({
        id: "chk",
        name: "Checking",
        type: "Checking",
        currency: "USD",
        startingBalance: 172120,
        countsAsSpendable: true,
      }),
    );
    await repos.settings.save({ ...SETTINGS, bufferAmount: 30000 });

    const state = await loadDashboardState();
    expect(state.safetyBuffer).toBe(30000);
    // Display only: the stored balance is untouched.
    expect(state.cashOnHand).toBe(172120);
    expect(displayedCashOnHand(state.cashOnHand, state.safetyBuffer)).toBe(142120);
  });

  it("defaults the buffer to 0", async () => {
    const db = getDb();
    const repos = createRepositories(db);
    await repos.accounts.put(
      mkAccount({
        id: "chk",
        name: "Checking",
        type: "Checking",
        currency: "USD",
        startingBalance: 172120,
        countsAsSpendable: true,
      }),
    );
    await repos.settings.save(SETTINGS);

    const state = await loadDashboardState();
    expect(state.safetyBuffer).toBe(0);
    expect(displayedCashOnHand(state.cashOnHand, state.safetyBuffer)).toBe(state.cashOnHand);
  });
});

describe("makeConverter", () => {
  it("prefers the account's fxRateToBase", () => {
    const convert = makeConverter("USD", new FxRateMemory(), () => {});
    const acct = mkAccount({ currency: "EUR", fxRateToBase: 1.2 });
    expect(convert(1000, "EUR", acct)).toBe(1200);
  });

  it("falls back to the last-used pair rate", () => {
    const mem = new FxRateMemory();
    mem.setRate("EUR", "USD", 1.1);
    const warnings: string[] = [];
    const convert = makeConverter("USD", mem, (c) => warnings.push(c));
    expect(convert(1000, "EUR")).toBe(1100);
    expect(warnings).toEqual([]);
  });

  it("records a visible warning and passes through when no rate exists", () => {
    const warnings: string[] = [];
    const convert = makeConverter("USD", new FxRateMemory(), (c) =>
      warnings.push(c),
    );
    expect(convert(1000, "EUR")).toBe(1000);
    expect(warnings).toEqual(["EUR"]);
    // Warned once per currency per load, not per transaction.
    expect(convert(2000, "EUR")).toBe(2000);
    expect(warnings).toEqual(["EUR"]);
  });

  it("passes base-currency amounts through untouched", () => {
    const convert = makeConverter("USD", new FxRateMemory(), () => {
      throw new Error("should not warn for base currency");
    });
    expect(convert(5000, "USD")).toBe(5000);
  });
});

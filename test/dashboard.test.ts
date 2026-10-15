/** Dashboard orchestration: snapshot refresh wiring and converter fallback. */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../src/data/db.js";
import { createRepositories } from "../src/data/repositories/index.js";
import {
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

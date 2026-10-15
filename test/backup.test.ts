/** Backup round-trip, validation, CSV, and reminder tests (fake-indexeddb). */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { MoneyTrackerDB } from "../src/data/db.js";
import { createRepositories, type Repositories } from "../src/data/repositories/index.js";
import {
  exportAll,
  importAll,
  markBackedUp,
  shouldRemindBackup,
  transactionsToCsv,
  validateBackup,
} from "../src/app/backup.js";
import { mkAccount, mkCategory, mkGoal, mkOverride, mkRule, mkSplit, mkTransaction, ACCTS } from "./helpers.js";
import type { DateOnly } from "../src/domain/dates/dateOnly.js";
import type { PaydayRunState, DailySnapshot, Settings } from "../src/domain/entities/settings.js";
import type { SnoozedMove } from "../src/domain/entities/snoozedMove.js";

const NOW = "2026-10-15T12:00:00.000Z";

function mkPaydayRun(o: Partial<PaydayRunState> = {}): PaydayRunState {
  return {
    id: "run-1",
    payDate: "2026-10-15" as DateOnly,
    expectedAmount: 226341,
    steps: { billsSetAside: false, goalContributions: {}, goalsStepDone: false, cardPaymentDone: false },
    completed: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...o,
  };
}

function mkSnapshot(o: Partial<DailySnapshot> = {}): DailySnapshot {
  return {
    id: "2026-10-15",
    date: "2026-10-15" as DateOnly,
    startOfDayAmount: 100000,
    available: 80000,
    committed: 20000,
    daysLeft: 15,
    createdAt: NOW,
    ...o,
  };
}

function mkSettings(o: Partial<Settings> = {}): Settings {
  return {
    id: "settings",
    baseCurrency: "USD",
    bufferAmount: 0,
    theme: "system",
    notificationsEnabled: false,
    onboardingCompleted: true,
    ...o,
  };
}

function mkSnooze(o: Partial<SnoozedMove> = {}): SnoozedMove {
  return { moveId: "move:p:rule-1:2026-10-15", snoozedUntil: "2026-10-15" as DateOnly, ...o };
}

async function seedAll(repos: Repositories): Promise<void> {
  await repos.accounts.putMany([mkAccount({ id: "a1" }), mkAccount({ id: "a2", name: "Savings" })]);
  await repos.categories.put(mkCategory({ id: "c1" }));
  await repos.transactions.putMany([
    mkTransaction({ id: "t1", accountId: "a1", categoryId: "c1", payee: 'Deli, "Best" Subs', amount: 1050 }),
    mkTransaction({ id: "t2", accountId: "a2", categoryId: null, type: "Transfer", amount: 5000, currency: "JPY" }),
  ]);
  await repos.recurringRules.put(mkRule({ id: "r1" }));
  await repos.recurringOverrides.put(mkOverride({ id: "r1:2026-10-15" }));
  await repos.goals.put(mkGoal({ id: "g1" }));
  await repos.splits.put(mkSplit({ id: "s1" }));
  await repos.settings.save(mkSettings());
  await repos.paydayRuns.put(mkPaydayRun());
  await repos.dailySnapshots.put(mkSnapshot());
  await repos.snoozedMoves.put(mkSnooze());
}

describe("backup export/import round-trip", () => {
  let db: MoneyTrackerDB;
  let db2: MoneyTrackerDB;
  afterEach(async () => {
    await db?.delete();
    await db2?.delete();
  });

  it("round-trips every table: row counts and a sample row survive", async () => {
    db = new MoneyTrackerDB(`bk-src-${Date.now()}`);
    const repos = createRepositories(db);
    await seedAll(repos);

    const exported = await exportAll(repos);
    expect(exported.version).toBe(1);
    expect(typeof exported.exportedAt).toBe("string");

    // Through real JSON serialization, like a file on disk.
    const parsed = JSON.parse(JSON.stringify(exported)) as unknown;
    const validated = validateBackup(parsed);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    db2 = new MoneyTrackerDB(`bk-dst-${Date.now()}`);
    const repos2 = createRepositories(db2);
    await importAll(repos2, validated.data);

    expect(await repos2.accounts.count()).toBe(2);
    expect(await repos2.categories.count()).toBe(1);
    expect(await repos2.transactions.count()).toBe(2);
    expect(await repos2.recurringRules.count()).toBe(1);
    expect(await repos2.recurringOverrides.count()).toBe(1);
    expect(await repos2.goals.count()).toBe(1);
    expect(await repos2.splits.count()).toBe(1);
    expect(await repos2.settings.count()).toBe(1);
    expect(await repos2.paydayRuns.count()).toBe(1);
    expect(await repos2.dailySnapshots.count()).toBe(1);
    expect(await repos2.snoozedMoves.count()).toBe(1);

    const tx = await repos2.transactions.getById("t1");
    expect(tx).toMatchObject({ payee: 'Deli, "Best" Subs', amount: 1050, status: "Cleared" });
    const snooze = await repos2.snoozedMoves.getById("move:p:rule-1:2026-10-15");
    expect(snooze).toMatchObject({ snoozedUntil: "2026-10-15" });
    const settings = await repos2.settings.get();
    expect(settings?.baseCurrency).toBe("USD");
    // Export stamps the backup time.
    expect(typeof settings?.lastBackupAt).toBe("string");
  });

  it("import wipes tables it does not receive rows for", async () => {
    db = new MoneyTrackerDB(`bk-wipe-${Date.now()}`);
    const repos = createRepositories(db);
    await repos.goals.put(mkGoal({ id: "stale" }));

    db2 = new MoneyTrackerDB(`bk-wipe2-${Date.now()}`);
    const repos2 = createRepositories(db2);
    await seedAll(repos2);
    const exported = await exportAll(repos2);
    const validated = validateBackup(JSON.parse(JSON.stringify(exported)) as unknown);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    await importAll(repos, validated.data);
    // The stale goal is gone; only the backup's goal remains.
    expect(await repos.goals.getAll()).toHaveLength(1);
    expect(await repos.goals.getById("g1")).toBeDefined();
  });
});

describe("validateBackup", () => {
  let db: MoneyTrackerDB;
  afterEach(async () => {
    await db?.delete();
  });

  async function freshRepos(): Promise<Repositories> {
    db = new MoneyTrackerDB(`bk-val-${Date.now()}-${Math.random()}`);
    const repos = createRepositories(db);
    await seedAll(repos);
    return repos;
  }

  async function goodJson(): Promise<unknown> {
    const repos = await freshRepos();
    return JSON.parse(JSON.stringify(await exportAll(repos))) as unknown;
  }

  it("rejects a non-object with a named error and imports nothing", async () => {
    const repos = await freshRepos();
    const before = await repos.transactions.count();
    for (const garbage of [null, 42, "nope", [1, 2], undefined]) {
      const result = validateBackup(garbage);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
    }
    expect(await repos.transactions.count()).toBe(before);
  });

  it("rejects a wrong version by name", async () => {
    const json = (await goodJson()) as Record<string, unknown>;
    json.version = 2;
    const result = validateBackup(json);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("version 2"))).toBe(true);
      expect(result.errors.some((e) => e.includes("version 1"))).toBe(true);
    }
  });

  it("rejects a missing version by name", async () => {
    const json = (await goodJson()) as Record<string, unknown>;
    delete json.version;
    const result = validateBackup(json);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("version"))).toBe(true);
  });

  it("rejects a missing table by name", async () => {
    const json = (await goodJson()) as { tables: Record<string, unknown> };
    delete json.tables.goals;
    const result = validateBackup(json);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes('"goals"'))).toBe(true);
  });

  it("rejects a row with a non-integer amount by name", async () => {
    const json = (await goodJson()) as { tables: { transactions: Record<string, unknown>[] } };
    json.tables.transactions[0]!.amount = 10.5;
    const result = validateBackup(json);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('"transactions"') && e.includes('"amount"'))).toBe(true);
    }
  });

  it("rejects a row missing its id by name", async () => {
    const json = (await goodJson()) as { tables: { accounts: Record<string, unknown>[] } };
    delete json.tables.accounts[0]!.id;
    const result = validateBackup(json);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('"accounts"') && e.includes('"id"'))).toBe(true);
    }
  });

  it("rejects a snoozedMoves row missing moveId by name", async () => {
    const json = (await goodJson()) as { tables: { snoozedMoves: Record<string, unknown>[] } };
    delete json.tables.snoozedMoves[0]!.moveId;
    const result = validateBackup(json);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes('"moveId"'))).toBe(true);
  });

  it("rejects a non-array table by name", async () => {
    const json = (await goodJson()) as { tables: Record<string, unknown> };
    json.tables.splits = { not: "a list" };
    const result = validateBackup(json);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes('"splits"'))).toBe(true);
  });
});

describe("transactionsToCsv", () => {
  it("writes the header and escapes commas and quotes in payees", () => {
    const accounts = ACCTS([mkAccount({ id: "a1", name: "Checking" })]);
    const categories = new Map([[mkCategory({ id: "c1", name: "Food" }).id, mkCategory({ id: "c1", name: "Food" })]]);
    const csv = transactionsToCsv(
      [
        mkTransaction({
          id: "t1",
          date: "2026-10-14",
          payee: 'Deli, "Best" Subs',
          type: "Expense",
          amount: 1050,
          currency: "USD",
          accountId: "a1",
          categoryId: "c1",
          status: "Cleared",
        }),
        mkTransaction({
          id: "t2",
          date: "2026-10-15",
          payee: "Conbini",
          type: "Expense",
          amount: 1000,
          currency: "JPY",
          accountId: "a1",
          categoryId: null,
          status: "Pending",
        }),
      ],
      accounts,
      categories,
    );
    const lines = csv.split("\n");
    expect(lines[0]).toBe("date,payee,type,amount,currency,account,category,status");
    expect(lines[1]).toBe('2026-10-14,"Deli, ""Best"" Subs",Expense,10.50,USD,Checking,Food,Cleared');
    // JPY has zero decimals: 1000 minor = 1000 major.
    expect(lines[2]).toBe("2026-10-15,Conbini,Expense,1000,JPY,Checking,,Pending");
  });
});

describe("shouldRemindBackup", () => {
  const NOW_ISO = "2026-10-15T12:00:00.000Z";

  it("reminds when never backed up", () => {
    expect(shouldRemindBackup(undefined, NOW_ISO)).toBe(true);
  });

  it("does not remind at 29 days", () => {
    expect(shouldRemindBackup("2026-09-16T12:00:00.000Z", NOW_ISO)).toBe(false);
  });

  it("reminds at 31 days", () => {
    expect(shouldRemindBackup("2026-09-14T12:00:00.000Z", NOW_ISO)).toBe(true);
  });

  it("does not remind at exactly 30 days", () => {
    expect(shouldRemindBackup("2026-09-15T12:00:00.000Z", NOW_ISO)).toBe(false);
  });

  it("reminds on garbage input", () => {
    expect(shouldRemindBackup("not-a-date", NOW_ISO)).toBe(true);
  });
});

describe("markBackedUp", () => {
  let db: MoneyTrackerDB;
  afterEach(async () => {
    await db?.delete();
  });

  it("stamps lastBackupAt on the existing settings row", async () => {
    db = new MoneyTrackerDB(`bk-mark-${Date.now()}`);
    const repos = createRepositories(db);
    await repos.settings.save(mkSettings({ lastBackupAt: undefined }));
    await markBackedUp(repos, NOW);
    expect((await repos.settings.get())?.lastBackupAt).toBe(NOW);
  });
});

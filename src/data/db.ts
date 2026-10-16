/** Dexie database definition. One table per entity, per the Phase 1 doc. */
import Dexie, { type Table } from "dexie";
import type { Account } from "../domain/entities/account.js";
import type { Category } from "../domain/entities/category.js";
import type { Transaction } from "../domain/entities/transaction.js";
import type { Goal } from "../domain/entities/goal.js";
import type { RecurringOverride, RecurringRule } from "../domain/entities/recurringRule.js";
import type { Split } from "../domain/entities/split.js";
import type { DailySnapshot, PaydayRunState, Settings } from "../domain/entities/settings.js";
import type { SnoozedMove } from "../domain/entities/snoozedMove.js";
import type { ImportBatch } from "../domain/entities/importBatch.js";
import type { BankFingerprint } from "../domain/entities/bankFingerprint.js";
import type { BankAccountMap } from "../domain/entities/bankAccountMap.js";
import type { ReviewItem } from "../domain/entities/reviewItem.js";
import type { MerchantRule } from "../domain/entities/merchantRule.js";

export class MoneyTrackerDB extends Dexie {
  accounts!: Table<Account, string>;
  categories!: Table<Category, string>;
  transactions!: Table<Transaction, string>;
  recurringRules!: Table<RecurringRule, string>;
  recurringOverrides!: Table<RecurringOverride, string>;
  goals!: Table<Goal, string>;
  splits!: Table<Split, string>;
  settings!: Table<Settings, string>;
  paydayRuns!: Table<PaydayRunState, string>;
  dailySnapshots!: Table<DailySnapshot, string>;
  snoozedMoves!: Table<SnoozedMove, string>;
  importBatches!: Table<ImportBatch, string>;
  bankFingerprints!: Table<BankFingerprint, string>;
  bankAccountMaps!: Table<BankAccountMap, string>;
  reviewItems!: Table<ReviewItem, string>;
  merchantRules!: Table<MerchantRule, string>;

  constructor(name = "money-tracker-v2") {
    super(name);
    this.version(1).stores({
      accounts: "id, archived",
      categories: "id, kind",
      transactions:
        "id, date, accountId, categoryId, status, recurringRuleId, [recurringRuleId+occurrenceDate], goalId",
      recurringRules: "id, nextDueDate, kind, active, lastGeneratedThrough",
      recurringOverrides: "id, ruleId, [ruleId+occurrenceDate]",
      goals: "id, paused, targetDate",
      splits: "id, settled, person",
      settings: "id",
      paydayRuns: "id, payDate, completed",
      dailySnapshots: "id, date",
    });
    // Version 2 adds the snoozedMoves store (Today's Moves snoozes).
    // Undeclared stores carry over, so every version-1 store is repeated
    // here; Dexie upgrades existing version-1 databases in place.
    this.version(2).stores({
      accounts: "id, archived",
      categories: "id, kind",
      transactions:
        "id, date, accountId, categoryId, status, recurringRuleId, [recurringRuleId+occurrenceDate], goalId",
      recurringRules: "id, nextDueDate, kind, active, lastGeneratedThrough",
      recurringOverrides: "id, ruleId, [ruleId+occurrenceDate]",
      goals: "id, paused, targetDate",
      splits: "id, settled, person",
      settings: "id",
      paydayRuns: "id, payDate, completed",
      dailySnapshots: "id, date",
      snoozedMoves: "moveId",
    });
    // Version 3 adds the bank-import stores (importBatches,
    // bankFingerprints, bankAccountMaps) and indexes the new optional
    // Transaction provenance fields (importBatchId, bankFingerprint).
    // Undeclared stores carry over, so every earlier store is repeated
    // here; Dexie upgrades existing databases in place.
    this.version(3).stores({
      accounts: "id, archived",
      categories: "id, kind",
      transactions:
        "id, date, accountId, categoryId, status, recurringRuleId, [recurringRuleId+occurrenceDate], goalId, importBatchId, bankFingerprint",
      recurringRules: "id, nextDueDate, kind, active, lastGeneratedThrough",
      recurringOverrides: "id, ruleId, [ruleId+occurrenceDate]",
      goals: "id, paused, targetDate",
      splits: "id, settled, person",
      settings: "id",
      paydayRuns: "id, payDate, completed",
      dailySnapshots: "id, date",
      snoozedMoves: "moveId",
      importBatches: "id, createdAt",
      bankFingerprints: "&fingerprint, batchId, transactionId",
      bankAccountMaps: "id, bankKey",
    });
    // Version 4 adds the Needs-review inbox (reviewItems) and the learned
    // merchant rules (merchantRules) for the Phase B matching engine.
    this.version(4).stores({
      accounts: "id, archived",
      categories: "id, kind",
      transactions:
        "id, date, accountId, categoryId, status, recurringRuleId, [recurringRuleId+occurrenceDate], goalId, importBatchId, bankFingerprint",
      recurringRules: "id, nextDueDate, kind, active, lastGeneratedThrough",
      recurringOverrides: "id, ruleId, [ruleId+occurrenceDate]",
      goals: "id, paused, targetDate",
      splits: "id, settled, person",
      settings: "id",
      paydayRuns: "id, payDate, completed",
      dailySnapshots: "id, date",
      snoozedMoves: "moveId",
      importBatches: "id, createdAt",
      bankFingerprints: "&fingerprint, batchId, transactionId",
      bankAccountMaps: "id, bankKey",
      reviewItems: "id, status, transactionId",
      merchantRules: "id, merchantKey",
    });
  }
}

let sharedDb: MoneyTrackerDB | null = null;

/** Shared database instance for the app (real user data). */
export function getDb(): MoneyTrackerDB {
  if (!sharedDb) sharedDb = new MoneyTrackerDB();
  return sharedDb;
}

let sharedDemoDb: MoneyTrackerDB | null = null;

/**
 * Separate database for the demo dataset ("money-tracker-demo").
 * Phase 1 decision 5: sample data lives in a clearly separate dataset that
 * can be wiped in one tap and never mixes with real data. Wiping the demo
 * database can never touch the real one.
 */
export function getDemoDb(): MoneyTrackerDB {
  if (!sharedDemoDb) sharedDemoDb = new MoneyTrackerDB("money-tracker-demo");
  return sharedDemoDb;
}

const DEMO_MODE_FLAG = "mtv2-demo-mode";
// Memory fallback for environments where localStorage is unavailable
// (private browsing, server-side rendering, tests).
let demoModeMemory = false;

function readFlag(): boolean {
  try {
    const v = localStorage.getItem(DEMO_MODE_FLAG);
    if (v !== null) return v === "1";
  } catch {
    /* fall through to memory */
  }
  return demoModeMemory;
}

function writeFlag(on: boolean): void {
  demoModeMemory = on;
  try {
    if (on) localStorage.setItem(DEMO_MODE_FLAG, "1");
    else localStorage.removeItem(DEMO_MODE_FLAG);
  } catch {
    /* storage unavailable: demo mode simply won't persist */
  }
}

/** True when the app is currently showing the demo dataset. */
export function isDemoMode(): boolean {
  return readFlag();
}

/** Switch the app between the demo database and the real database. */
export function setDemoMode(on: boolean): void {
  writeFlag(on);
}

/** The database the app reads/writes right now: demo or real. */
export function getActiveDb(): MoneyTrackerDB {
  return isDemoMode() ? getDemoDb() : getDb();
}

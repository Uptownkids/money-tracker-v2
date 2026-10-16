/** Typed repositories, one per entity, plus a factory. */
import type { MoneyTrackerDB } from "../db.js";
import { Repository } from "./base.js";
import type { Account } from "../../domain/entities/account.js";
import type { Category } from "../../domain/entities/category.js";
import type { Transaction } from "../../domain/entities/transaction.js";
import type { Goal } from "../../domain/entities/goal.js";
import type { RecurringOverride, RecurringRule } from "../../domain/entities/recurringRule.js";
import type { Split } from "../../domain/entities/split.js";
import type { DailySnapshot, PaydayRunState, Settings } from "../../domain/entities/settings.js";
import type { SnoozedMove } from "../../domain/entities/snoozedMove.js";
import type { ImportBatch } from "../../domain/entities/importBatch.js";
import type { BankFingerprint } from "../../domain/entities/bankFingerprint.js";
import type { BankAccountMap } from "../../domain/entities/bankAccountMap.js";
import type { DateOnly } from "../../domain/dates/dateOnly.js";
import { countsTowardCommitment } from "../../domain/engine/goals.js";

export class AccountRepository extends Repository<Account> {
  active(): Promise<Account[]> {
    return this.table.filter((a) => !a.archived).toArray();
  }
}

export class CategoryRepository extends Repository<Category> {
  byKind(kind: Category["kind"]): Promise<Category[]> {
    return this.table.where("kind").equals(kind).toArray();
  }
}

export class TransactionRepository extends Repository<Transaction> {
  byDateRange(from: DateOnly, to: DateOnly): Promise<Transaction[]> {
    return this.table.where("date").between(from, to, true, true).toArray();
  }

  byAccount(accountId: string): Promise<Transaction[]> {
    return this.table.where("accountId").equals(accountId).toArray();
  }

  byStatus(status: Transaction["status"]): Promise<Transaction[]> {
    return this.table.where("status").equals(status).toArray();
  }

  /** Find the generated row for a rule occurrence (dedupe key). */
  byRuleOccurrence(ruleId: string, occurrenceDate: DateOnly): Promise<Transaction | undefined> {
    return this.table.where("[recurringRuleId+occurrenceDate]").equals([ruleId, occurrenceDate]).first();
  }

  byGoal(goalId: string): Promise<Transaction[]> {
    return this.table.where("goalId").equals(goalId).toArray();
  }

  /** Every transaction created by one import batch (for rollback). */
  byImportBatch(batchId: string): Promise<Transaction[]> {
    return this.table.where("importBatchId").equals(batchId).toArray();
  }

  async deleteMany(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.table.where("id").anyOf([...ids]).delete();
  }
}

export class RecurringRuleRepository extends Repository<RecurringRule> {
  active(): Promise<RecurringRule[]> {
    return this.table.filter((r) => r.active).toArray();
  }
}

export class RecurringOverrideRepository extends Repository<RecurringOverride> {
  byRule(ruleId: string): Promise<RecurringOverride[]> {
    return this.table.where("ruleId").equals(ruleId).toArray();
  }

  byRuleOccurrence(ruleId: string, occurrenceDate: DateOnly): Promise<RecurringOverride | undefined> {
    return this.table.where("[ruleId+occurrenceDate]").equals([ruleId, occurrenceDate]).first();
  }
}

export class GoalRepository extends Repository<Goal> {
  active(): Promise<Goal[]> {
    return this.table.filter((g) => countsTowardCommitment(g)).toArray();
  }
}

export class SplitRepository extends Repository<Split> {
  unsettled(): Promise<Split[]> {
    return this.table.filter((s) => !s.settled).toArray();
  }
}

export class SettingsRepository extends Repository<Settings> {
  get(): Promise<Settings | undefined> {
    return this.table.get("settings");
  }

  save(settings: Settings): Promise<string> {
    return this.put({ ...settings, id: "settings" });
  }
}

export class PaydayRunRepository extends Repository<PaydayRunState> {
  byPayDate(payDate: DateOnly): Promise<PaydayRunState[]> {
    return this.table.where("payDate").equals(payDate).toArray();
  }
}

export class DailySnapshotRepository extends Repository<DailySnapshot> {
  byDate(date: DateOnly): Promise<DailySnapshot | undefined> {
    return this.table.get(date);
  }
}

/**
 * Today's Moves snoozes, keyed by move id. "Snooze" writes
 * { moveId, snoozedUntil: today }; the dashboard hides the move while
 * snoozedUntil >= today and garbage-collects expired rows on load.
 *
 * Standalone (not a Repository<SnoozedMove>): the Dexie primary key is
 * `moveId`, and the shared Repository base requires an `id` field.
 */
export class SnoozedMoveRepository {
  private table: MoneyTrackerDB["snoozedMoves"];

  constructor(table: MoneyTrackerDB["snoozedMoves"]) {
    this.table = table;
  }

  getAll(): Promise<SnoozedMove[]> {
    return this.table.toArray();
  }

  count(): Promise<number> {
    return this.table.count();
  }

  getById(moveId: string): Promise<SnoozedMove | undefined> {
    return this.table.get(moveId);
  }

  put(snooze: SnoozedMove): Promise<string> {
    return this.table.put(snooze);
  }

  putMany(snoozes: SnoozedMove[]): Promise<void> {
    return this.table.bulkPut(snoozes).then(() => undefined);
  }

  remove(moveId: string): Promise<void> {
    return this.table.delete(moveId);
  }

  clear(): Promise<void> {
    return this.table.clear();
  }
}

export class BankFingerprintRepository {
  private table: MoneyTrackerDB["bankFingerprints"];

  constructor(table: MoneyTrackerDB["bankFingerprints"]) {
    this.table = table;
  }

  get(fingerprint: string): Promise<BankFingerprint | undefined> {
    return this.table.get(fingerprint);
  }

  getAll(): Promise<BankFingerprint[]> {
    return this.table.toArray();
  }

  async getMany(fingerprints: readonly string[]): Promise<Map<string, BankFingerprint>> {
    const rows = await this.table.where("fingerprint").anyOf([...fingerprints]).toArray();
    return new Map(rows.map((r) => [r.fingerprint, r]));
  }

  /** How many rows already exist per fingerprint (count-based dedup). */
  async countByFingerprints(fingerprints: readonly string[]): Promise<Map<string, number>> {
    const rows = await this.table.where("fingerprint").anyOf([...fingerprints]).toArray();
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.fingerprint, (counts.get(r.fingerprint) ?? 0) + 1);
    return counts;
  }

  putMany(rows: BankFingerprint[]): Promise<void> {
    return this.table.bulkPut(rows).then(() => undefined);
  }

  byBatch(batchId: string): Promise<BankFingerprint[]> {
    return this.table.where("batchId").equals(batchId).toArray();
  }

  async deleteByBatch(batchId: string): Promise<void> {
    await this.table.where("batchId").equals(batchId).delete();
  }

  /** Forget every fingerprint pointing at a deleted transaction. */
  async deleteByTransactionIds(transactionIds: readonly string[]): Promise<void> {
    if (transactionIds.length === 0) return;
    await this.table.where("transactionId").anyOf([...transactionIds]).delete();
  }

  clear(): Promise<void> {
    return this.table.clear();
  }
}

export interface Repositories {
  accounts: AccountRepository;
  categories: CategoryRepository;
  transactions: TransactionRepository;
  recurringRules: RecurringRuleRepository;
  recurringOverrides: RecurringOverrideRepository;
  goals: GoalRepository;
  splits: SplitRepository;
  settings: SettingsRepository;
  paydayRuns: PaydayRunRepository;
  dailySnapshots: DailySnapshotRepository;
  snoozedMoves: SnoozedMoveRepository;
  importBatches: Repository<ImportBatch>;
  bankFingerprints: BankFingerprintRepository;
  bankAccountMaps: Repository<BankAccountMap>;
}

/** Build all repositories bound to one database instance. */
export function createRepositories(db: MoneyTrackerDB): Repositories {
  return {
    accounts: new AccountRepository(db.accounts),
    categories: new CategoryRepository(db.categories),
    transactions: new TransactionRepository(db.transactions),
    recurringRules: new RecurringRuleRepository(db.recurringRules),
    recurringOverrides: new RecurringOverrideRepository(db.recurringOverrides),
    goals: new GoalRepository(db.goals),
    splits: new SplitRepository(db.splits),
    settings: new SettingsRepository(db.settings),
    paydayRuns: new PaydayRunRepository(db.paydayRuns),
    dailySnapshots: new DailySnapshotRepository(db.dailySnapshots),
    snoozedMoves: new SnoozedMoveRepository(db.snoozedMoves),
    importBatches: new Repository<ImportBatch>(db.importBatches),
    bankFingerprints: new BankFingerprintRepository(db.bankFingerprints),
    bankAccountMaps: new Repository<BankAccountMap>(db.bankAccountMaps),
  };
}

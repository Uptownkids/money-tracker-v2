/**
 * Backup: export every Dexie table to a versioned JSON blob, validate a
 * backup before it can be imported, wipe-and-restore on import, and export
 * transactions to CSV. All date math stays on UTC ISO strings; money stays
 * in integer minor units until CSV render time.
 */
import type { Repositories } from "../data/repositories/index.js";
import type { Account } from "../domain/entities/account.js";
import type { Category } from "../domain/entities/category.js";
import type { Transaction } from "../domain/entities/transaction.js";
import type { Goal } from "../domain/entities/goal.js";
import type { RecurringOverride, RecurringRule } from "../domain/entities/recurringRule.js";
import type { Split } from "../domain/entities/split.js";
import type { DailySnapshot, PaydayRunState, Settings } from "../domain/entities/settings.js";
import type { SnoozedMove } from "../domain/entities/snoozedMove.js";
import { decimalsOf } from "../domain/money/currency.js";

export const BACKUP_VERSION = 1;
/** Days without a backup before the banner nudges. */
export const BACKUP_REMINDER_DAYS = 30;

export interface BackupTables {
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  recurringRules: RecurringRule[];
  recurringOverrides: RecurringOverride[];
  goals: Goal[];
  splits: Split[];
  settings: Settings[];
  paydayRuns: PaydayRunState[];
  dailySnapshots: DailySnapshot[];
  snoozedMoves: SnoozedMove[];
}

export interface BackupData {
  version: 1;
  exportedAt: string;
  tables: BackupTables;
}

const TABLE_NAMES = [
  "accounts",
  "categories",
  "transactions",
  "recurringRules",
  "recurringOverrides",
  "goals",
  "splits",
  "settings",
  "paydayRuns",
  "dailySnapshots",
  "snoozedMoves",
] as const;

type TableName = (typeof TABLE_NAMES)[number];

function defaultSettings(nowIso: string): Settings {
  return {
    id: "settings",
    baseCurrency: "USD",
    bufferAmount: 0,
    theme: "system",
    notificationsEnabled: false,
    onboardingCompleted: false,
    lastBackupAt: nowIso,
  };
}

/** Stamp settings.lastBackupAt to now (used by every export path). */
export async function markBackedUp(repos: Repositories, nowIso: string): Promise<void> {
  const existing = await repos.settings.get();
  if (existing) {
    await repos.settings.save({ ...existing, lastBackupAt: nowIso });
  } else {
    await repos.settings.save(defaultSettings(nowIso));
  }
}

/** Serialize every table to a versioned JSON object. Stamps lastBackupAt. */
export async function exportAll(repos: Repositories): Promise<BackupData> {
  const nowIso = new Date().toISOString();
  // Stamp first so the exported settings row carries the fresh backup time.
  await markBackedUp(repos, nowIso);
  const tables: BackupTables = {
    accounts: await repos.accounts.getAll(),
    categories: await repos.categories.getAll(),
    transactions: await repos.transactions.getAll(),
    recurringRules: await repos.recurringRules.getAll(),
    recurringOverrides: await repos.recurringOverrides.getAll(),
    goals: await repos.goals.getAll(),
    splits: await repos.splits.getAll(),
    settings: await repos.settings.getAll(),
    paydayRuns: await repos.paydayRuns.getAll(),
    dailySnapshots: await repos.dailySnapshots.getAll(),
    snoozedMoves: await repos.snoozedMoves.getAll(),
  };
  return { version: BACKUP_VERSION, exportedAt: nowIso, tables };
}

/** Trigger a browser download of a JSON-serializable value. */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Hand a JSON backup file to the user. On devices with the Web Share API
 * (iOS installed apps), the system share sheet is used: a programmatic
 * anchor download silently vanishes in the iOS standalone PWA, leaving
 * the user with no file. Falls back to the anchor download elsewhere.
 * Returns how the file was handed off. Rejects with AbortError if the
 * user dismisses the share sheet — callers should treat that as a
 * cancel, not a failure.
 */
export async function exportJsonFile(
  filename: string,
  data: unknown,
): Promise<"shared" | "downloaded"> {
  const file = new File([JSON.stringify(data, null, 2)], filename, {
    type: "application/json",
  });
  const nav =
    typeof navigator !== "undefined"
      ? (navigator as Navigator & {
          canShare?: (data: { files: File[] }) => boolean;
          share?: (data: { files: File[]; title?: string }) => Promise<void>;
        })
      : undefined;
  if (nav?.canShare?.({ files: [file] }) && nav.share) {
    await nav.share({ files: [file], title: "Money Tracker backup" });
    return "shared";
  }
  downloadJson(filename, data);
  return "downloaded";
}

/**
 * Same share-first handoff for text exports (CSV). Falls back to the
 * anchor download where Web Share is unavailable.
 */
export async function exportTextFile(
  filename: string,
  text: string,
  mime: string,
): Promise<"shared" | "downloaded"> {
  const file = new File([text], filename, { type: mime });
  const nav =
    typeof navigator !== "undefined"
      ? (navigator as Navigator & {
          canShare?: (data: { files: File[] }) => boolean;
          share?: (data: { files: File[]; title?: string }) => Promise<void>;
        })
      : undefined;
  if (nav?.canShare?.({ files: [file] }) && nav.share) {
    await nav.share({ files: [file], title: filename });
    return "shared";
  }
  downloadText(filename, text, mime);
  return "downloaded";
}

/** Trigger a browser download of a text file. */
export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Primary-key field per table (snoozedMoves is keyed by moveId, not id).
const ID_FIELDS: Record<TableName, string> = {
  accounts: "id",
  categories: "id",
  transactions: "id",
  recurringRules: "id",
  recurringOverrides: "id",
  goals: "id",
  splits: "id",
  settings: "id",
  paydayRuns: "id",
  dailySnapshots: "id",
  snoozedMoves: "moveId",
};
const INTEGER_FIELDS: Record<TableName, string[]> = {
  accounts: ["startingBalance"],
  categories: [],
  transactions: ["amount"],
  recurringRules: ["amount"],
  recurringOverrides: [],
  goals: ["targetAmount"],
  splits: ["amount"],
  settings: ["bufferAmount"],
  paydayRuns: ["expectedAmount"],
  dailySnapshots: ["startOfDayAmount", "available", "committed", "daysLeft"],
  snoozedMoves: [],
};

/** Cap the reported problems so one corrupt file can't flood the UI. */
const MAX_ERRORS = 25;

export type BackupValidation =
  | { ok: true; data: BackupData }
  | { ok: false; errors: string[] };

/**
 * Check a parsed JSON value is a usable backup. Never throws: garbage in
 * means a named error out, and nothing is imported.
 */
export function validateBackup(json: unknown): BackupValidation {
  const errors: string[] = [];
  const fail = (msg: string): BackupValidation => {
    errors.push(msg);
    return { ok: false, errors };
  };

  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return fail("This file is not a backup. It should be a JSON object.");
  }
  const root = json as Record<string, unknown>;

  if (root.version === undefined) {
    return fail('This backup is missing its version field ("version").');
  }
  if (root.version !== BACKUP_VERSION) {
    return fail(
      `This backup is version ${String(root.version)}. This app reads version ${BACKUP_VERSION} backups only.`,
    );
  }

  const tables = root.tables;
  if (typeof tables !== "object" || tables === null || Array.isArray(tables)) {
    return fail('This backup is missing its tables ("tables" must be an object).');
  }
  const tableObj = tables as Record<string, unknown>;

  for (const name of TABLE_NAMES) {
    const rows = tableObj[name];
    if (rows === undefined) {
      errors.push(`This backup is missing the "${name}" table.`);
      continue;
    }
    if (!Array.isArray(rows)) {
      errors.push(`The "${name}" table must be a list of rows.`);
      continue;
    }
    const intFields = INTEGER_FIELDS[name];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (errors.length >= MAX_ERRORS) break;
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        errors.push(`The "${name}" table has a row at position ${i} that is not an object.`);
        continue;
      }
      const r = row as Record<string, unknown>;
      const idField = ID_FIELDS[name];
      const rowId = r[idField];
      if (typeof rowId !== "string" || rowId.length === 0) {
        errors.push(`The "${name}" table has a row at position ${i} with a missing or invalid "${idField}".`);
      }
      for (const field of intFields) {
        const v = r[field];
        if (v !== undefined && !Number.isInteger(v)) {
          errors.push(
            `The "${name}" table row "${String(rowId) || i}" has "${field}" = ${JSON.stringify(v)}, which is not a whole minor-unit number.`,
          );
        }
      }
    }
    if (errors.length >= MAX_ERRORS) break;
  }

  if (errors.length > MAX_ERRORS) {
    return {
      ok: false,
      errors: [...errors.slice(0, MAX_ERRORS), `...and ${errors.length - MAX_ERRORS} more problems.`],
    };
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data: json as BackupData };
}

/**
 * Wipe every table and bulk-restore from a validated backup. Only call
 * after validateBackup returned ok AND the user confirmed the replace.
 */
export async function importAll(repos: Repositories, data: BackupData): Promise<void> {
  const t = data.tables;
  // Clear everything first so a failure can't leave half old, half new.
  await Promise.all([
    repos.accounts.clear(),
    repos.categories.clear(),
    repos.transactions.clear(),
    repos.recurringRules.clear(),
    repos.recurringOverrides.clear(),
    repos.goals.clear(),
    repos.splits.clear(),
    repos.settings.clear(),
    repos.paydayRuns.clear(),
    repos.dailySnapshots.clear(),
    repos.snoozedMoves.clear(),
  ]);
  await Promise.all([
    repos.accounts.putMany(t.accounts),
    repos.categories.putMany(t.categories),
    repos.transactions.putMany(t.transactions),
    repos.recurringRules.putMany(t.recurringRules),
    repos.recurringOverrides.putMany(t.recurringOverrides),
    repos.goals.putMany(t.goals),
    repos.splits.putMany(t.splits),
    repos.settings.putMany(t.settings),
    repos.paydayRuns.putMany(t.paydayRuns),
    repos.dailySnapshots.putMany(t.dailySnapshots),
    repos.snoozedMoves.putMany(t.snoozedMoves),
  ]);
}


function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Transactions as CSV. Amounts render in major units with the currency's
 * own decimals (JPY has none, most have two).
 */
export function transactionsToCsv(
  transactions: Transaction[],
  accountsById: Map<string, Account>,
  categoriesById: Map<string, Category>,
): string {
  const header = "date,payee,type,amount,currency,account,category,status";
  const lines = transactions.map((t) => {
    let amountMajor: string;
    try {
      const d = decimalsOf(t.currency);
      amountMajor = (t.amount / 10 ** d).toFixed(d);
    } catch {
      amountMajor = String(t.amount);
    }
    const account = accountsById.get(t.accountId)?.name ?? "";
    const category = t.categoryId ? (categoriesById.get(t.categoryId)?.name ?? "") : "";
    return [
      t.date,
      t.payee,
      t.type,
      amountMajor,
      t.currency,
      account,
      category,
      t.status,
    ]
      .map(csvCell)
      .join(",");
  });
  return [header, ...lines].join("\n");
}

/**
 * True when a backup reminder is due: never backed up, or the last one
 * is more than 30 days old. Pure; both inputs are ISO strings.
 */
export function shouldRemindBackup(
  lastBackupAt: string | undefined,
  nowIso: string,
): boolean {
  if (!lastBackupAt) return true;
  const last = Date.parse(lastBackupAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(last) || !Number.isFinite(now)) return true;
  return now - last > BACKUP_REMINDER_DAYS * 86_400_000;
}

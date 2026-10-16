/**
 * CSV import orchestration (Phase A: fully local).
 *
 * Flow: parse files -> map each file to an app account -> fingerprint
 * every row -> count-based dedup against the fingerprint index AND
 * within the import -> preview -> commit (one batch) -> rollback.
 *
 * Phase A maps rows naively (negative -> Expense, positive -> Income);
 * Phase B replaces the row mapper with the matching engine
 * (duplicates, bill matches, transfer pairing, categorization).
 * The batch/rollback/dedup plumbing is phase-independent.
 */
import type { Repositories } from "../data/repositories/index.js";
import type { DateOnly } from "../domain/dates/dateOnly.js";
import type { MinorUnits } from "../domain/money/money.js";
import type { Transaction } from "../domain/entities/transaction.js";
import type { ImportBatch } from "../domain/entities/importBatch.js";
import type { BankFingerprint, BankRowOutcome } from "../domain/entities/bankFingerprint.js";
import {
  parseWellsFargoCsv,
  type AmountSignConvention,
  type ParsedBankRow,
  type WellsFargoColumnMap,
} from "../domain/import/wellsFargoCsv.js";
import { bankRowFingerprint, collapseCrossFileDuplicates, planDedup } from "../domain/import/fingerprints.js";

/** One uploaded file plus the account it belongs to. */
export interface CsvFileInput {
  fileName: string;
  text: string;
  /** User-chosen label for the bank account (remembered across imports). */
  bankKey: string;
  appAccountId: string;
  sign?: AmountSignConvention;
  columnMap?: WellsFargoColumnMap;
}

export interface PlannedRow {
  fileName: string;
  row: ParsedBankRow;
  accountId: string;
  fingerprint: string;
  /** True when this row will be skipped as a duplicate. */
  duplicate: boolean;
}

export interface ImportPreview {
  files: { fileName: string; rows: number; errors: string[] }[];
  planned: PlannedRow[];
  newCount: number;
  duplicateCount: number;
}

/**
 * Parse every file and plan the import: fingerprint each row and run
 * count-based dedup against the stored fingerprint index. Pooling all
 * files means duplicates are caught across files, not just within one.
 */
export async function previewCsvImport(
  repos: Repositories,
  files: CsvFileInput[],
): Promise<ImportPreview> {
  // Validate account ids up front so a typo fails before any parsing.
  const accounts = await repos.accounts.getAll();
  const accountIds = new Set(accounts.map((a) => a.id));
  for (const f of files) {
    if (!accountIds.has(f.appAccountId)) {
      throw new Error(`previewCsvImport: unknown appAccountId "${f.appAccountId}" for file "${f.fileName}"`);
    }
  }

  const planned: PlannedRow[] = [];
  const fileSummaries: ImportPreview["files"] = [];
  for (const f of files) {
    const { rows, errors } = parseWellsFargoCsv(f.text, {
      columnMap: f.columnMap,
      sign: f.sign,
    });
    fileSummaries.push({ fileName: f.fileName, rows: rows.length, errors });
    for (const row of rows) {
      planned.push({
        fileName: f.fileName,
        row,
        accountId: f.appAccountId,
        fingerprint: bankRowFingerprint({
          accountId: f.appAccountId,
          date: row.date,
          amountMinor: row.amountMinor,
          description: row.description,
          stableId: row.stableId,
        }),
        duplicate: false,
      });
    }
  }

  // Overlapping exports: the same row in two files is one transaction.
  // (Identical rows within ONE file are kept for the count-based check —
  // two same-day transactions can both be real.)
  const crossFileDropped = collapseCrossFileDuplicates(
    planned,
    (p) => p.fingerprint,
    (p) => p.fileName,
  );
  const dedupCandidates = planned.filter((p) => !crossFileDropped.has(p));

  const counts = await repos.bankFingerprints.countByFingerprints(
    dedupCandidates.map((p) => p.fingerprint),
  );
  const { skipped } = planDedup(
    dedupCandidates,
    (p) => p.fingerprint,
    (fp) => counts.get(fp) ?? 0,
  );
  const skippedSet = new Set([...skipped, ...crossFileDropped]);
  for (const p of planned) p.duplicate = skippedSet.has(p);

  return {
    files: fileSummaries,
    planned,
    newCount: planned.length - skippedSet.size,
    duplicateCount: skippedSet.size,
  };
}

export interface CommitResult {
  batch: ImportBatch;
  importedIds: string[];
}

/**
 * Commit a preview: create Cleared transactions for every non-duplicate
 * row, record fingerprints, remember the bank->app account mapping, and
 * write the batch record. Phase A mapping is deliberately naive —
 * sign decides Expense vs Income; Phase B upgrades this to the matching
 * engine. Throws on empty commits (nothing to import).
 */
export async function commitCsvImport(
  repos: Repositories,
  preview: ImportPreview,
  files: CsvFileInput[],
): Promise<CommitResult> {
  const toImport = preview.planned.filter((p) => !p.duplicate);
  if (toImport.length === 0) {
    throw new Error("commitCsvImport: nothing new to import (all rows are duplicates)");
  }

  const now = new Date().toISOString();
  const batchId = crypto.randomUUID();

  // Category defaults: first expense-kind and income-kind categories.
  const categories = await repos.categories.getAll();
  const expenseCat = categories.find((c) => c.kind === "expense" && !c.archived);
  const incomeCat = categories.find((c) => c.kind === "income" && !c.archived);
  if (!expenseCat || !incomeCat) {
    throw new Error("commitCsvImport: no usable categories found");
  }

  const transactions: Transaction[] = toImport.map((p) => {
    const isOutflow = p.row.amountMinor < 0;
    return {
      id: crypto.randomUUID(),
      type: isOutflow ? "Expense" : "Income",
      amount: Math.abs(p.row.amountMinor) as MinorUnits,
      currency: "USD",
      date: p.row.date as DateOnly,
      accountId: p.accountId,
      categoryId: isOutflow ? expenseCat.id : incomeCat.id,
      payee: p.row.description,
      status: "Cleared",
      notes: "",
      tags: [],
      bankFingerprint: p.fingerprint,
      importBatchId: batchId,
      createdAt: now,
      updatedAt: now,
    };
  });

  const fingerprints: BankFingerprint[] = toImport.map((p, i): BankFingerprint => ({
    fingerprint: p.fingerprint,
    transactionId: (transactions[i] as Transaction).id,
    batchId,
    outcome: "imported" as BankRowOutcome,
    createdAt: now,
  }));
  // Note: rows skipped as duplicates need no fingerprint entry — the
  // original entry (from the earlier batch) stays authoritative, and a
  // rollback of the earlier batch removes it, making the row importable
  // again. The duplicate count lives on the batch stats.

  await repos.transactions.putMany(transactions);
  // Best-effort: fingerprint rows may collide on re-commit; the unique
  // index keeps the first write.
  for (const fp of fingerprints) {
    const existing = await repos.bankFingerprints.get(fp.fingerprint);
    if (!existing) await repos.bankFingerprints.putMany([fp]);
  }

  // Remember the bank -> app account mapping (upsert by bankKey).
  const maps = await repos.bankAccountMaps.getAll();
  const byKey = new Map(maps.map((m) => [m.bankKey.toLowerCase(), m]));
  for (const f of files) {
    const key = f.bankKey.trim();
    if (!key) continue;
    const existing = byKey.get(key.toLowerCase());
    if (existing) {
      if (existing.appAccountId !== f.appAccountId) {
        await repos.bankAccountMaps.put({ ...existing, appAccountId: f.appAccountId, updatedAt: now });
      }
    } else {
      const created = {
        id: crypto.randomUUID(),
        bankKey: key,
        appAccountId: f.appAccountId,
        createdAt: now,
        updatedAt: now,
      };
      await repos.bankAccountMaps.put(created);
      byKey.set(key.toLowerCase(), created);
    }
  }

  const batch: ImportBatch = {
    id: batchId,
    createdAt: now,
    fileNames: files.map((f) => f.fileName),
    stats: {
      rows: preview.planned.length,
      imported: toImport.length,
      duplicates: preview.duplicateCount,
    },
    status: "committed",
  };
  await repos.importBatches.put(batch);

  return { batch, importedIds: transactions.map((t) => t.id) };
}

/**
 * Roll back one import batch completely: delete every transaction it
 * created, forget fingerprints that pointed at those transactions, and
 * mark the batch rolled-back. Fingerprint entries from OTHER batches
 * that referenced the deleted transactions are also removed, so those
 * rows become importable again instead of dangling.
 */
export async function rollbackImportBatch(
  repos: Repositories,
  batchId: string,
): Promise<{ deletedTransactions: number }> {
  const batch = await repos.importBatches.getById(batchId);
  if (!batch) throw new Error(`rollbackImportBatch: unknown batch "${batchId}"`);
  if (batch.status === "rolled-back") {
    throw new Error("rollbackImportBatch: batch is already rolled back");
  }

  const txs = await repos.transactions.byImportBatch(batchId);
  const ids = txs.map((t) => t.id);

  await repos.bankFingerprints.deleteByTransactionIds(ids);
  await repos.bankFingerprints.deleteByBatch(batchId);
  await repos.transactions.deleteMany(ids);
  await repos.importBatches.put({ ...batch, status: "rolled-back" });

  return { deletedTransactions: ids.length };
}

/** Suggest a bank account label from a file name ("wf-checking.csv" -> "wf-checking"). */
export function suggestBankKey(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").replace(/[_\s]+/g, "-").toLowerCase();
}

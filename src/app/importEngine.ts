/**
 * Phase B import engine: runs every incoming row through the matching
 * pipeline (decideRow) and executes the decisions.
 *
 * Two steps, so the UI can show a full reconciliation summary before
 * committing: planImport (pure planning, no writes) then commitImport.
 */
import type { Repositories } from "../data/repositories/index.js";
import type { DateOnly } from "../domain/dates/dateOnly.js";
import type { MinorUnits } from "../domain/money/money.js";
import type { Transaction } from "../domain/entities/transaction.js";
import type { BankFingerprint, BankRowOutcome } from "../domain/entities/bankFingerprint.js";
import type { ReviewItem, ReviewReason } from "../domain/entities/reviewItem.js";
import { deriveBalances } from "../domain/engine/balances.js";
import { cleanPayee, merchantKey } from "../domain/import/payeeClean.js";
import {
  buildHistoryFor,
  decideRow,
  type MatchContext,
  type RowDecision,
} from "../domain/import/matching.js";
import { previewCsvImport, type CsvFileInput, type ImportPreview } from "./csvImport.js";
import {
  detectAndCreateRules,
  previewRecurringDetection,
  type CreatedRuleInfo,
  type DetectionOutcome,
} from "./recurringDetect.js";
import type { ImportBatch } from "../domain/entities/importBatch.js";

export interface PlannedDecision {
  plannedRowIndex: number;
  decision: RowDecision;
}

export interface ImportPlan {
  preview: ImportPreview;
  decisions: PlannedDecision[];
  summary: {
    newRows: number;
    duplicates: number;
    matched: number;
    billSettled: number;
    transfersNew: number;
    transfersAbsorbed: number;
    needsReview: number;
  };
  /** Bills/subscriptions the commit would auto-detect (dry run). */
  recurringPreview: { wouldCreate: number; wouldSuggest: number; wouldEnd: number };
}

async function buildContext(repos: Repositories): Promise<MatchContext> {
  const [transactions, accounts, categories, learnedRules, settings] = await Promise.all([
    repos.transactions.getAll(),
    repos.accounts.getAll(),
    repos.categories.getAll(),
    repos.merchantRules.getAll(),
    repos.settings.get(),
  ]);
  return {
    transactions,
    accounts,
    categories,
    learnedRules,
    settings: settings ?? {
      id: "settings",
      baseCurrency: "USD",
      bufferAmount: 0,
      theme: "system",
      notificationsEnabled: false,
      onboardingCompleted: false,
    },
  };
}

/** Plan the full import: dedup, then one decision per new row. No writes. */
export async function planImport(
  repos: Repositories,
  files: CsvFileInput[],
): Promise<ImportPlan> {
  const preview = await previewCsvImport(repos, files);
  const ctx = await buildContext(repos);
  const history = buildHistoryFor(ctx);

  const decisions: PlannedDecision[] = [];
  const summary = {
    newRows: 0,
    duplicates: preview.duplicateCount,
    matched: 0,
    billSettled: 0,
    transfersNew: 0,
    transfersAbsorbed: 0,
    needsReview: 0,
  };

  preview.planned.forEach((p, index) => {
    if (p.duplicate) return;
    summary.newRows++;
    const decision = decideRow(ctx, p.row, p.accountId, history);
    decisions.push({ plannedRowIndex: index, decision });
    switch (decision.kind) {
      case "match-existing":
        summary.matched++;
        break;
      case "bill-settle":
        summary.billSettled++;
        break;
      case "transfer":
        if (decision.absorbIntoId) summary.transfersAbsorbed++;
        else summary.transfersNew++;
        if (!decision.pairConfirmed && !decision.absorbIntoId) summary.needsReview++;
        break;
      case "transfer-unknown-account":
        summary.needsReview++;
        break;
      case "ambiguous-match":
        summary.needsReview++;
        break;
      case "categorize":
        if (decision.needsReview) summary.needsReview++;
        break;
    }
  });

  const recurringPreview = await previewRecurringDetection(repos);

  return { preview, decisions, summary, recurringPreview };
}

export interface ReconciliationRow {
  accountId: string;
  accountName: string;
  appBalance: MinorUnits;
  statementBalance?: MinorUnits;
  /** appBalance - statementBalance, when a statement was entered. */
  diff?: MinorUnits;
}

export interface CommitSummary {
  /** Null when there was nothing new to import (no batch written). */
  batch: ImportBatch | null;
  imported: number;
  matched: number;
  billSettled: number;
  transfersNew: number;
  transfersAbsorbed: number;
  needsReview: number;
  reviewItemIds: string[];
  /** Bills/subscriptions auto-detected by this import (Phase B2). */
  recurring: DetectionOutcome;
  reconciliation: ReconciliationRow[];
}

function fallbackCategoryId(ctx: MatchContext, kind: "expense" | "income"): string {
  const byName = (n: string) =>
    ctx.categories.find((c) => c.kind === kind && c.name.toLowerCase() === n && !c.archived);
  return (byName(kind === "expense" ? "Other" : "Income") ?? ctx.categories.find((c) => c.kind === kind && !c.archived))?.id ?? "";
}

/**
 * Execute a plan: persist transactions, fingerprint entries, review items,
 * and the batch record. Returns the summary for the "before you commit"
 * reconciliation screen (statement balances optional).
 */
export async function commitImport(
  repos: Repositories,
  plan: ImportPlan,
  files: CsvFileInput[],
  statementBalances?: Record<string, MinorUnits>,
): Promise<CommitSummary> {
  const ctx = await buildContext(repos);
  const now = new Date().toISOString();
  const batchId = crypto.randomUUID();
  const planned = plan.preview.planned;

  const newTransactions: Transaction[] = [];
  const updatedTransactions: Transaction[] = [];
  const fingerprints: BankFingerprint[] = [];
  const reviewItems: ReviewItem[] = [];
  const summary = {
    imported: 0,
    matched: 0,
    billSettled: 0,
    transfersNew: 0,
    transfersAbsorbed: 0,
    needsReview: 0,
  };

  const recordFingerprint = (
    fingerprint: string,
    transactionId: string | null,
    outcome: BankRowOutcome,
  ) => {
    fingerprints.push({ fingerprint, transactionId, batchId, outcome, createdAt: now });
  };

  const queueReview = (
    transactionId: string,
    reasons: ReviewReason[],
    guess: ReviewItem["guess"],
    rawDescription: string,
  ) => {
    const item: ReviewItem = {
      id: crypto.randomUUID(),
      transactionId,
      reasons,
      guess,
      merchantKey: merchantKey(cleanPayee(rawDescription)),
      status: "open",
      createdAt: now,
    };
    reviewItems.push(item);
    summary.needsReview++;
    return item;
  };

  const buildCategorized = (
    fingerprint: string,
    accountId: string,
    date: DateOnly,
    amountMinor: MinorUnits,
    rawDescription: string,
    type: Transaction["type"],
    categoryId: string | undefined,
    payee: string,
  ): Transaction => ({
    id: crypto.randomUUID(),
    type,
    amount: Math.abs(amountMinor) as MinorUnits,
    currency: "USD",
    date,
    accountId,
    categoryId: categoryId || fallbackCategoryId(ctx, type === "Income" ? "income" : "expense"),
    payee,
    status: "Cleared",
    notes: "",
    tags: [],
    bankFingerprint: fingerprint,
    importBatchId: batchId,
    createdAt: now,
    updatedAt: now,
  });

  for (const { plannedRowIndex, decision } of plan.decisions) {
    const p = planned[plannedRowIndex] as (typeof planned)[number];
    const absAmount = Math.abs(p.row.amountMinor) as MinorUnits;

    switch (decision.kind) {
      case "match-existing": {
        const existing = ctx.transactions.find((t) => t.id === decision.transactionId);
        if (!existing) break;
        const updated: Transaction = {
          ...existing,
          status: "Cleared",
          amount: decision.postedUpdate?.amount ?? existing.amount,
          date: decision.postedUpdate?.date ?? existing.date,
          bankFingerprint: p.fingerprint,
          updatedAt: now,
        };
        updatedTransactions.push(updated);
        recordFingerprint(p.fingerprint, existing.id, "matched");
        summary.matched++;
        break;
      }

      case "bill-settle": {
        const bill = ctx.transactions.find((t) => t.id === decision.scheduledId);
        if (!bill) break;
        // In-place settlement mirrors Quick-Log: status, amount, date and
        // paying account change; the rule link, category, payee and the
        // transfer destination stay untouched (debt payments stay
        // Transfers).
        const settled: Transaction = {
          ...bill,
          status: "Cleared",
          amount: absAmount,
          date: p.row.date,
          accountId: p.accountId,
          bankFingerprint: p.fingerprint,
          updatedAt: now,
        };
        updatedTransactions.push(settled);
        recordFingerprint(p.fingerprint, bill.id, "bill-settled");
        summary.billSettled++;
        break;
      }

      case "transfer": {
        if (decision.absorbIntoId) {
          recordFingerprint(p.fingerprint, decision.absorbIntoId, "transfer-absorbed");
          summary.transfersAbsorbed++;
          break;
        }
        const tx: Transaction = {
          id: crypto.randomUUID(),
          type: "Transfer",
          amount: absAmount,
          currency: "USD",
          date: p.row.date,
          accountId: decision.fromAccountId,
          transferToAccountId: decision.toAccountId,
          categoryId: null,
          payee: cleanPayee(p.row.description),
          status: "Cleared",
          notes: "",
          tags: [],
          bankFingerprint: p.fingerprint,
          importBatchId: batchId,
          createdAt: now,
          updatedAt: now,
        };
        newTransactions.push(tx);
        recordFingerprint(p.fingerprint, tx.id, "imported");
        summary.transfersNew++;
        if (!decision.pairConfirmed) {
          queueReview(tx.id, ["transfer-unconfirmed"], {
            type: "Transfer",
            payee: tx.payee,
            transferToAccountId: decision.toAccountId,
          }, p.row.description);
        }
        break;
      }

      case "transfer-unknown-account": {
        // Money moved; record it via categorization so balances stay
        // right, and ask him to mark it as a transfer.
        const tx = buildCategorized(
          p.fingerprint, p.accountId, p.row.date, p.row.amountMinor, p.row.description,
          p.row.amountMinor < 0 ? "Expense" : "Income",
          undefined, cleanPayee(p.row.description),
        );
        newTransactions.push(tx);
        recordFingerprint(p.fingerprint, tx.id, "imported");
        summary.imported++;
        queueReview(tx.id, ["transfer-unknown-account"], decision.guess, p.row.description);
        break;
      }

      case "ambiguous-match": {
        const tx = buildCategorized(
          p.fingerprint, p.accountId, p.row.date, p.row.amountMinor, p.row.description,
          p.row.amountMinor < 0 ? "Expense" : "Income",
          undefined, cleanPayee(p.row.description),
        );
        newTransactions.push(tx);
        recordFingerprint(p.fingerprint, tx.id, "imported");
        summary.imported++;
        queueReview(tx.id, ["ambiguous-match"], {
          type: tx.type,
          categoryId: tx.categoryId ?? undefined,
          payee: tx.payee,
        }, p.row.description);
        break;
      }

      case "categorize": {
        const tx = buildCategorized(
          p.fingerprint, p.accountId, p.row.date, p.row.amountMinor, p.row.description,
          decision.guess.type,
          decision.guess.categoryId, decision.guess.payee ?? cleanPayee(p.row.description),
        );
        // Refunds keep a link-friendly note; they net the category.
        newTransactions.push(tx);
        recordFingerprint(p.fingerprint, tx.id, "imported");
        summary.imported++;
        if (decision.needsReview) {
          queueReview(tx.id, decision.reasons, decision.guess, p.row.description);
        }
        break;
      }
    }
  }

  // Nothing new (e.g. re-importing the same file): no-op, no batch.
  // The preview already told the user everything was a duplicate.
  if (plan.decisions.length === 0) {
    return {
      batch: null,
      imported: 0,
      matched: 0,
      billSettled: 0,
      transfersNew: 0,
      transfersAbsorbed: 0,
      needsReview: 0,
      reviewItemIds: [],
      recurring: { created: [], pastSubscriptions: 0, suggested: 0, flagged: 0 },
      reconciliation: [],
    };
  }

  await repos.transactions.putMany(newTransactions);
  for (const u of updatedTransactions) await repos.transactions.put(u);
  for (const fp of fingerprints) {
    const existing = await repos.bankFingerprints.get(fp.fingerprint);
    if (!existing) await repos.bankFingerprints.putMany([fp]);
  }
  if (reviewItems.length > 0) await repos.reviewItems.putMany(reviewItems);

  // Remember bank -> app account mappings.
  const maps = await repos.bankAccountMaps.getAll();
  const byKey = new Map(maps.map((m) => [m.bankKey.toLowerCase(), m]));
  for (const f of files) {
    const key = f.bankKey.trim();
    if (!key || byKey.has(key.toLowerCase())) continue;
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

  const batch: ImportBatch = {
    id: batchId,
    createdAt: now,
    fileNames: files.map((f) => f.fileName),
    stats: {
      rows: plan.preview.planned.length,
      imported: summary.imported + summary.transfersNew,
      duplicates: plan.preview.duplicateCount,
    },
    status: "committed",
  };
  await repos.importBatches.put(batch);

  // Reconciliation: app balances after import vs optional statement.
  const accounts = await repos.accounts.getAll();
  const transactions = await repos.transactions.getAll();
  const balances = deriveBalances(accounts, transactions);
  const reconciliation: ReconciliationRow[] = accounts
    .filter((a) => !a.archived)
    .map((a) => {
      const statementBalance = statementBalances?.[a.id];
      return {
        accountId: a.id,
        accountName: a.name,
        appBalance: balances[a.id] ?? a.startingBalance,
        statementBalance,
        diff: statementBalance === undefined ? undefined : (((balances[a.id] ?? 0) - statementBalance) as MinorUnits),
      };
    });

  // Phase B2: detect recurring bills/subscriptions from the new rows.
  // This runs after the rows exist so tagging can find them.
  const recurring = await detectAndCreateRules(repos, newTransactions);

  return {
    batch,
    ...summary,
    reviewItemIds: reviewItems.map((r) => r.id),
    recurring,
    reconciliation,
  };
}

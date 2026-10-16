/**
 * Pending vs posted reconciliation (Phase B; built for live sync).
 *
 * Bank pending transactions import as Pending. When they post, the same
 * row is updated in place (the amount may change — tips, gas holds)
 * instead of creating a new row. A pending charge that disappears
 * without posting is removed and reported.
 *
 * All functions are pure; the caller persists the results.
 */
import type { DateOnly } from "../dates/dateOnly.js";
import { diffDays } from "../dates/dateOnly.js";
import type { MinorUnits } from "../money/money.js";
import type { Transaction } from "../entities/transaction.js";
import { normalizeDescription } from "./fingerprints.js";

export interface PostedRow {
  date: DateOnly;
  amountMinor: MinorUnits; // signed, positive = inflow
  description: string;
  stableId?: string;
}

/**
 * Find the pending transaction a posted row settles. Match order:
 *  1. stable bank id (e.g. Zelle Ref #) — exact.
 *  2. same account, normalized description, date within ±7 days.
 * Amount is deliberately NOT part of the key: the posted amount may
 * differ from the pending authorization (tips, holds).
 * Returns null when no single pending row matches.
 */
export function matchPendingToPosted(
  pending: readonly Transaction[],
  row: PostedRow,
  accountId: string,
): Transaction | null {
  const candidates = pending.filter(
    (t) => t.status === "Pending" && t.accountId === accountId,
  );
  if (row.stableId) {
    const hit = candidates.filter((t) => t.bankFingerprint === row.stableId);
    if (hit.length === 1) return hit[0] as Transaction;
    if (hit.length > 1) return null; // ambiguous: don't guess
  }
  const normRow = normalizeDescription(row.description);
  const hits = candidates.filter((t) => {
    if (Math.abs(diffDays(t.date, row.date)) > 7) return false;
    return normalizeDescription(t.payee) === normRow;
  });
  return hits.length === 1 ? (hits[0] as Transaction) : null;
}

export interface PostedUpdate {
  transactionId: string;
  /** True when the posted amount differed from the pending amount. */
  amountChanged: boolean;
  oldAmount: MinorUnits;
  newAmount: MinorUnits;
}

/**
 * Apply a posted row onto its pending match: status -> Cleared, amount
 * and date updated to the posted values. Returns the update summary, or
 * null when there is no match (the caller imports it as a new row).
 */
export function applyPostedToPending(
  pending: readonly Transaction[],
  row: PostedRow,
  accountId: string,
  nowIso: string,
): { updated: Transaction; summary: PostedUpdate } | null {
  const match = matchPendingToPosted(pending, row, accountId);
  if (!match) return null;
  const newAmount = Math.abs(row.amountMinor) as MinorUnits;
  const updated: Transaction = {
    ...match,
    status: "Cleared",
    amount: newAmount,
    date: row.date,
    bankFingerprint: row.stableId ?? match.bankFingerprint,
    updatedAt: nowIso,
  };
  return {
    updated,
    summary: {
      transactionId: match.id,
      amountChanged: newAmount !== match.amount,
      oldAmount: match.amount,
      newAmount,
    },
  };
}

/**
 * Pending rows with no posted counterpart after `graceDays` (default 14)
 * are assumed to have vanished: the caller removes them and tells the
 * user. Returns the vanished rows.
 */
export function findVanishedPending(
  pending: readonly Transaction[],
  postedRows: readonly PostedRow[],
  accountId: string,
  today: DateOnly,
  graceDays = 14,
): Transaction[] {
  const vanished: Transaction[] = [];
  for (const t of pending) {
    if (t.status !== "Pending" || t.accountId !== accountId) continue;
    if (diffDays(t.date, today) < graceDays) continue;
    const stillThere = postedRows.some(
      (r) => matchPendingToPosted([t], r, accountId) !== null,
    );
    if (!stillThere) vanished.push(t);
  }
  return vanished;
}

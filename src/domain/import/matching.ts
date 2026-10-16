/**
 * The import matching engine (Phase B). Every incoming bank row goes
 * through these checks, in order:
 *  1. Duplicate check (fingerprint index — done before this runs).
 *  2. Match to an existing manually-logged entry (date ±3d, exact
 *     amount; pending rows may update amount on posting).
 *  3. Match to an open Scheduled bill (settle in place, Quick-Log
 *     semantics: debt payments stay Transfers).
 *  4. Transfer detection: self-transfers (online / Zelle) and pairing
 *     across imports. Never an expense plus an income.
 *  5. Categorization (history, then rules).
 *  6. Anything unsure -> Needs review.
 *
 * Pure: decisions only. `src/app/importEngine.ts` executes them.
 */
import type { DateOnly } from "../dates/dateOnly.js";
import { diffDays } from "../dates/dateOnly.js";
import type { MinorUnits } from "../money/money.js";
import type { Account } from "../entities/account.js";
import type { Category } from "../entities/category.js";
import type { Settings } from "../entities/settings.js";
import type { MerchantRule } from "../entities/merchantRule.js";
import type { ReviewGuess, ReviewReason } from "../entities/reviewItem.js";
import { affectsBalance, type Transaction } from "../entities/transaction.js";
import type { ParsedBankRow } from "./wellsFargoCsv.js";
import { normalizeDescription } from "./fingerprints.js";
import { cleanPayee } from "./payeeClean.js";
import {
  DEFAULT_SELF_NAME_VARIATIONS,
  detectTransferSignal,
  isSelfCounterparty,
  otherAccountLabel,
} from "./selfTransfers.js";
import { buildMerchantHistory, categorize, type MerchantHistory } from "./categorize.js";
import { findBillMatch } from "../../app/quickLog.js";

export interface MatchContext {
  transactions: readonly Transaction[];
  accounts: readonly Account[];
  categories: readonly Category[];
  learnedRules: readonly MerchantRule[];
  settings: Settings;
}

export type RowDecision =
  | { kind: "match-existing"; transactionId: string; postedUpdate: { amount: MinorUnits; date: DateOnly } | null }
  | { kind: "ambiguous-match"; candidateIds: string[] }
  | { kind: "bill-settle"; scheduledId: string }
  | {
      kind: "transfer";
      fromAccountId: string;
      toAccountId: string;
      pairKey: string;
      pairConfirmed: boolean;
      absorbIntoId?: string;
    }
  | { kind: "transfer-unknown-account"; guess: ReviewGuess }
  | { kind: "categorize"; guess: ReviewGuess; reasons: ReviewReason[]; needsReview: boolean };

function selfVariations(settings: Settings): readonly string[] {
  return settings.selfNameVariations?.length ? settings.selfNameVariations : DEFAULT_SELF_NAME_VARIATIONS;
}

function transferNameMaps(settings: Settings): Record<string, string> {
  return settings.transferAccountNameMaps ?? {};
}

function confirmedPairs(settings: Settings): ReadonlySet<string> {
  return new Set(settings.confirmedTransferPairs ?? []);
}

/** Step 2: match a manually-logged entry. Exact amount, date ±3 days. */
export function matchExistingEntry(
  ctx: MatchContext,
  row: ParsedBankRow,
  accountId: string,
): { transactionId: string; postedUpdate: { amount: MinorUnits; date: DateOnly } | null } | "ambiguous" | null {
  const absAmount = Math.abs(row.amountMinor) as MinorUnits;
  const candidates = ctx.transactions.filter((t) => {
    if (t.accountId !== accountId) return false;
    if (!affectsBalance(t)) return false; // Scheduled rows are bills, not entries
    if (t.bankFingerprint) return false; // already bank-linked
    if (t.type === "Transfer" && t.transferToAccountId === accountId) return false; // inbound side
    if (Math.abs(diffDays(t.date, row.date)) > 3) return false;
    return t.amount === absAmount;
  });
  if (candidates.length === 0) {
    // Pending -> posted: the amount may have changed (tips, holds).
    // Match on description + wider date window, then update in place.
    const normRow = normalizeDescription(row.description);
    const pending = ctx.transactions.filter((t) => {
      if (t.accountId !== accountId || t.status !== "Pending") return false;
      if (t.bankFingerprint) return false;
      if (Math.abs(diffDays(t.date, row.date)) > 7) return false;
      return normalizeDescription(t.payee) === normRow;
    });
    if (pending.length === 1) {
      const t = pending[0] as Transaction;
      return {
        transactionId: t.id,
        postedUpdate:
          t.amount === absAmount && t.date === row.date ? null : { amount: absAmount, date: row.date },
      };
    }
    return null;
  }
  if (candidates.length > 1) return "ambiguous";
  const t = candidates[0] as Transaction;
  return { transactionId: t.id, postedUpdate: null };
}

/** Step 3: match an open Scheduled bill (Quick-Log bill-match semantics). */
export function matchScheduledBill(
  ctx: MatchContext,
  row: ParsedBankRow,
  accountId: string,
): string | null {
  const absAmount = Math.abs(row.amountMinor) as MinorUnits;
  const match = findBillMatch(ctx.transactions, {
    date: row.date,
    payee: cleanPayee(row.description),
    amountMinor: absAmount,
  });
  return match ? match.transaction.id : null;
}

export interface TransferDecision {
  kind: "transfer" | "unknown-account" | "not-a-transfer";
  fromAccountId?: string;
  toAccountId?: string;
  pairKey?: string;
  absorbIntoId?: string;
  guess?: ReviewGuess;
}

/**
 * Step 4: transfer detection. Returns "not-a-transfer" for ordinary rows.
 * Self-transfers (online / Zelle-to-self) resolve both accounts; when the
 * other side already exists as a Transfer (imported earlier from the
 * other account's file), the row is absorbed into it.
 */
export function detectTransfer(
  ctx: MatchContext,
  row: ParsedBankRow,
  accountId: string,
): TransferDecision {
  const signal = detectTransferSignal(row.description);
  if (!signal) return { kind: "not-a-transfer" };
  const variations = selfVariations(ctx.settings);
  if (!isSelfCounterparty(signal.counterparty, variations)) {
    // Zelle/transfer to someone else: NOT a transfer. Normal flow.
    return { kind: "not-a-transfer" };
  }

  const absAmount = Math.abs(row.amountMinor) as MinorUnits;
  // Direction: "TO" = money leaving this account.
  const moneyOut = signal.direction === "TO";
  let otherAccountId: string | undefined;

  if (signal.kind === "online-transfer") {
    const label = otherAccountLabel(signal, variations);
    if (label) {
      const mapped = transferNameMaps(ctx.settings)[label];
      if (mapped && ctx.accounts.some((a) => a.id === mapped)) otherAccountId = mapped;
    }
  } else {
    // Zelle names no account; recall the counterpart mapped for this
    // account+direction, if Malike has confirmed one before.
    const remembered =
      transferNameMaps(ctx.settings)[`zelle:${accountId}:${signal.direction}`];
    if (remembered && ctx.accounts.some((a) => a.id === remembered)) otherAccountId = remembered;
  }

  if (!otherAccountId) {
    // Ask him: best guess when there is exactly one plausible account.
    return {
      kind: "unknown-account",
      guess: {
        type: "Transfer",
        payee: cleanPayee(row.description),
        transferToAccountId: moneyOut ? undefined : accountId,
      },
    };
  }

  const fromAccountId = moneyOut ? accountId : otherAccountId;
  const toAccountId = moneyOut ? otherAccountId : accountId;
  const pairKey = `${fromAccountId}>${toAccountId}`;

  // Pairing: does the other side already exist as a Transfer?
  const existing = ctx.transactions.find((t) => {
    if (t.type !== "Transfer" || !t.transferToAccountId) return false;
    if (t.accountId !== fromAccountId || t.transferToAccountId !== toAccountId) return false;
    if (t.amount !== absAmount) return false;
    return Math.abs(diffDays(t.date, row.date)) <= 3;
  });
  if (existing) {
    return { kind: "transfer", fromAccountId, toAccountId, pairKey, absorbIntoId: existing.id };
  }
  return { kind: "transfer", fromAccountId, toAccountId, pairKey };
}

/** Full per-row decision through steps 2-6. Step 1 (dedup) runs before. */
export function decideRow(
  ctx: MatchContext,
  row: ParsedBankRow,
  accountId: string,
  history: ReadonlyMap<string, MerchantHistory>,
): RowDecision {
  // Step 2: existing entry.
  const existing = matchExistingEntry(ctx, row, accountId);
  if (existing === "ambiguous") {
    const absAmount = Math.abs(row.amountMinor) as MinorUnits;
    const candidateIds = ctx.transactions
      .filter(
        (t) =>
          t.accountId === accountId &&
          affectsBalance(t) &&
          !t.bankFingerprint &&
          Math.abs(diffDays(t.date, row.date)) <= 3 &&
          t.amount === absAmount,
      )
      .map((t) => t.id);
    return { kind: "ambiguous-match", candidateIds };
  }
  if (existing) {
    return { kind: "match-existing", transactionId: existing.transactionId, postedUpdate: existing.postedUpdate };
  }

  // Step 3: scheduled bill.
  const billId = matchScheduledBill(ctx, row, accountId);
  if (billId) return { kind: "bill-settle", scheduledId: billId };

  // Step 4: transfers.
  const transfer = detectTransfer(ctx, row, accountId);
  if (transfer.kind === "transfer") {
    return {
      kind: "transfer",
      fromAccountId: transfer.fromAccountId as string,
      toAccountId: transfer.toAccountId as string,
      pairKey: transfer.pairKey as string,
      pairConfirmed: confirmedPairs(ctx.settings).has(transfer.pairKey as string),
      absorbIntoId: transfer.absorbIntoId,
    };
  }
  if (transfer.kind === "unknown-account") {
    return { kind: "transfer-unknown-account", guess: transfer.guess as ReviewGuess };
  }

  // Steps 5-6: categorize; unsure -> review.
  const cleaned = cleanPayee(row.description);
  const result = categorize({
    rawDescription: row.description,
    isOutflow: row.amountMinor < 0,
    categories: ctx.categories,
    learnedRules: ctx.learnedRules,
    history,
  });
  const absAmount = Math.abs(row.amountMinor) as MinorUnits;
  const reasons: ReviewReason[] = [];
  if (result.via === "refund" && !result.categoryId) reasons.push("refund-unknown-category");
  if (!result.categoryId || result.confidence === "low") reasons.push("uncategorized");
  const guess: ReviewGuess = {
    type: result.isRefund ? "Refund" : row.amountMinor < 0 ? "Expense" : "Income",
    categoryId: result.categoryId ?? undefined,
    payee: result.payee,
  };
  return {
    kind: "categorize",
    guess,
    reasons,
    needsReview: reasons.length > 0,
  };
}

/** Build the merchant history index for a context (once per import). */
export function buildHistoryFor(ctx: Pick<MatchContext, "transactions">): Map<string, MerchantHistory> {
  return buildMerchantHistory(
    ctx.transactions.map((t) => ({ payee: t.payee, categoryId: t.categoryId })),
  );
}

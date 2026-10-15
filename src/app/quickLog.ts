/**
 * Quick-log: the one-tap entry path. Parses a human-typed dollar amount
 * into minor units and persists a fully-formed Transaction through the
 * repositories layer.
 */
import type { DateOnly } from "../domain/dates/dateOnly.js";
import { addDays, diffDays } from "../domain/dates/dateOnly.js";
import { decimalsOf } from "../domain/money/currency.js";
import type { MinorUnits } from "../domain/money/money.js";
import type { Transaction, TransactionType } from "../domain/entities/transaction.js";
import type { Repositories } from "../data/repositories/index.js";

export interface QuickLogInput {
  type: Extract<TransactionType, "Expense" | "Income" | "Transfer">;
  amountMinor: MinorUnits;
  accountId: string;
  toAccountId?: string; // required when type === "Transfer"
  categoryId: string | null; // null for Transfer
  payee: string;
  date: DateOnly;
  notes?: string;
  /**
   * "Paid from goal": tag the entry as spending from a goal's earmarked
   * funds. The engine excludes goal-tagged expenses from today's
   * discretionary spending and subtracts them from the goal's earmark,
   * so this must ONLY be set on Expense entries — never Transfer or
   * Income, and never on the settle-scheduled-bill path. A missing goal
   * fails the save; the tag is never silently dropped.
   */
  goalId?: string;
  /**
   * Settle path: instead of creating a new transaction, update this
   * Scheduled transaction in place (status -> Cleared, amount/date/account
   * from the input; transferToAccountId untouched for Transfers). Used when
   * a quick-logged expense turns out to be a bill payment (see findBillMatch).
   */
  settleScheduledId?: string;
}

export interface QuickLogResult {
  transaction: Transaction;
}

/**
 * Parse a human-typed dollar string into minor units. Accepts "$1,234.56",
 * "12.34", "12", "  7.5 ". Returns null for empty, non-numeric, zero,
 * negative, more decimals than the currency allows, or non-finite input.
 * All arithmetic stays in integers — no floating point.
 */
export function parseDollarsToMinor(text: string, currency?: string): MinorUnits | null {
  const decimals = decimalsOf(currency ?? "USD");
  const stripped = text.replace(/[$,\s]/g, "");
  if (stripped === "") return null;
  const pattern = decimals === 0 ? /^\d+$/ : new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
  if (!pattern.test(stripped)) return null;
  const [whole, frac = ""] = stripped.split(".");
  const minorStr = whole + frac.padEnd(decimals, "0");
  const minor = Number(minorStr);
  if (!Number.isSafeInteger(minor) || minor <= 0) return null;
  return minor;
}

/**
 * Validate and persist a quick-log entry as a Cleared transaction.
 * Transfers force categoryId to null and require an existing
 * destination account. When settleScheduledId is set, the referenced
 * Scheduled transaction is updated in place instead of creating a new
 * one. Throws a descriptive Error on invalid input.
 */
export async function saveQuickLog(repos: Repositories, input: QuickLogInput): Promise<QuickLogResult> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new Error("saveQuickLog: amountMinor must be a positive integer (minor units)");
  }
  const account = await repos.accounts.getById(input.accountId);
  if (!account) {
    throw new Error(`saveQuickLog: unknown accountId "${input.accountId}"`);
  }

  // "Paid from goal" validation, up front so every path fails loud:
  // Expense-only, never on bill settlement (that flow is untouched), and
  // the goal must exist at save time.
  if (input.goalId !== undefined) {
    if (input.settleScheduledId !== undefined) {
      throw new Error("saveQuickLog: goalId cannot be used when settling a scheduled bill");
    }
    if (input.type !== "Expense") {
      throw new Error(
        `saveQuickLog: goalId is only supported for Expense entries (got "${input.type}")`,
      );
    }
    const goal = await repos.goals.getById(input.goalId);
    if (!goal) {
      throw new Error(`saveQuickLog: unknown goalId "${input.goalId}"`);
    }
  }

  if (input.settleScheduledId !== undefined) {
    const bill = await repos.transactions.getById(input.settleScheduledId);
    if (!bill) {
      throw new Error(`saveQuickLog: unknown settleScheduledId "${input.settleScheduledId}"`);
    }
    if (bill.status !== "Scheduled") {
      throw new Error(
        `saveQuickLog: settleScheduledId "${input.settleScheduledId}" is not Scheduled (status: ${bill.status})`,
      );
    }
    // A debt Transfer can never be paid from the account it pays to —
    // that would be a self-transfer that moves nothing.
    if (
      bill.transferToAccountId !== undefined &&
      bill.transferToAccountId !== "" &&
      input.accountId === bill.transferToAccountId
    ) {
      throw new Error("Pick a different account than the one being paid.");
    }
    // In-place settlement: status, amount, date, and the paying account
    // (and updatedAt) change. recurringRuleId, occurrenceDate, categoryId,
    // payee, and (for Transfers) transferToAccountId are untouched, so
    // spending summaries that key on recurringRuleId stay right.
    const now = new Date().toISOString();
    const amountChanged = input.amountMinor !== bill.amount;
    const accountChanged = input.accountId !== bill.accountId;
    const settled: Transaction = {
      ...bill,
      status: "Cleared",
      amount: input.amountMinor,
      // FX freeze handling (mirrors the ledger edit): if the amount and the
      // paying account are both untouched, keep the bill's currency/fx
      // triple exactly as-is. Otherwise the new amount is authoritative in
      // the picked account's currency and the stale freeze must go —
      // otherwise the engine would keep using fx.baseAmount and silently
      // ignore the settlement. (amount is always written from the input;
      // it equals bill.amount exactly when !amountChanged.)
      currency: !amountChanged && !accountChanged && bill.fx ? bill.currency : account.currency,
      date: input.date,
      accountId: input.accountId,
      updatedAt: now,
    };
    if (amountChanged || accountChanged) delete settled.fx;
    await repos.transactions.put(settled);
    return { transaction: settled };
  }

  let transferToAccountId: string | undefined;
  if (input.type === "Transfer") {
    if (!input.toAccountId) {
      throw new Error("saveQuickLog: toAccountId is required when type is Transfer");
    }
    const dest = await repos.accounts.getById(input.toAccountId);
    if (!dest) {
      throw new Error(`saveQuickLog: unknown toAccountId "${input.toAccountId}"`);
    }
    if (input.accountId === input.toAccountId) {
      throw new Error("Pick two different accounts for a transfer.");
    }
    transferToAccountId = dest.id;
  }

  const now = new Date().toISOString();
  const transaction: Transaction = {
    id: crypto.randomUUID(),
    type: input.type,
    amount: input.amountMinor,
    currency: account.currency,
    date: input.date,
    accountId: input.accountId,
    categoryId: input.type === "Transfer" ? null : input.categoryId,
    payee: input.payee,
    status: "Cleared",
    notes: input.notes ?? "",
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
  if (transferToAccountId !== undefined) {
    transaction.transferToAccountId = transferToAccountId;
  }
  if (input.goalId !== undefined) {
    transaction.goalId = input.goalId;
  }
  await repos.transactions.put(transaction);
  return { transaction };
}

/* ------------------------------------------------------------------ */
/* Payee suggestions                                                   */
/* ------------------------------------------------------------------ */

const normPayee = (s: string): string => s.trim().toLowerCase();

/** Copy of the transactions sorted most-recent-first (date, then createdAt). */
function mostRecentFirst(transactions: readonly Transaction[]): Transaction[] {
  return [...transactions].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return 0;
  });
}

export interface PayeeSuggestion {
  payee: string;
  categoryId: string | null;
  accountId: string;
}

/**
 * Suggest the most recent transaction whose payee starts with the given
 * prefix (case-insensitive, trimmed). Returns its payee, categoryId, and
 * accountId for prefilling the form. Null when the prefix is empty or
 * nothing matches.
 */
export function suggestPayee(
  transactions: readonly Transaction[],
  prefix: string,
): PayeeSuggestion | null {
  const needle = normPayee(prefix);
  if (needle === "") return null;
  const match = mostRecentFirst(transactions).find((t) =>
    normPayee(t.payee).startsWith(needle),
  );
  if (!match) return null;
  return { payee: match.payee, categoryId: match.categoryId, accountId: match.accountId };
}

/**
 * Unique payee strings matching the same prefix rule as suggestPayee,
 * most-recent-first, capped at `limit`. Empty/blank prefix returns [].
 */
export function payeeCompletions(
  transactions: readonly Transaction[],
  prefix: string,
  limit = 6,
): string[] {
  const needle = normPayee(prefix);
  if (needle === "" || limit <= 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of mostRecentFirst(transactions)) {
    if (!normPayee(t.payee).startsWith(needle)) continue;
    if (seen.has(t.payee)) continue;
    seen.add(t.payee);
    out.push(t.payee);
    if (out.length >= limit) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Bill-payment matching                                               */
/* ------------------------------------------------------------------ */

export interface BillMatchInput {
  payee: string;
  amountMinor: number;
  date: DateOnly;
}

export interface BillMatch {
  transaction: Transaction;
}

/**
 * Find a Scheduled bill this quick-log entry might be paying, so the
 * sheet can offer to settle it in place instead of double-counting.
 *
 * Candidates: status Scheduled, type not Income, a recurringRuleId set,
 * and date within 7 days after the entry date (overdue bills included).
 * A candidate matches on EITHER payee (normalized, either contains the
 * other; the entered payee must be at least 3 trimmed characters, so short
 * entries like "A" never trigger a payee match) OR exact amount. Ranking: a
 * payee match beats an amount-only match; ties break by closest date.
 */
export function findBillMatch(
  transactions: readonly Transaction[],
  input: BillMatchInput,
): BillMatch | null {
  const horizon = addDays(input.date, 7); // inclusive; overdue bills satisfy this bound
  const needle = normPayee(input.payee);

  let best: Transaction | null = null;
  let bestPayeeHit = false;
  let bestDist = Number.POSITIVE_INFINITY;

  for (const t of transactions) {
    if (t.status !== "Scheduled") continue;
    if (t.type === "Income") continue;
    if (!t.recurringRuleId) continue;
    if (t.date > horizon) continue;

    const tPayee = normPayee(t.payee);
    // Short entered payees (under 3 trimmed characters) never count as a
    // payee match — "A" matching "Con Edison" is a false prompt. Amount-only
    // matches are unaffected.
    const payeeHit =
      needle.length >= 3 &&
      tPayee !== "" &&
      (tPayee.includes(needle) || needle.includes(tPayee));
    const amountHit = t.amount === input.amountMinor;
    if (!payeeHit && !amountHit) continue;

    const dist = Math.abs(diffDays(t.date, input.date));
    if (
      best === null ||
      (payeeHit && !bestPayeeHit) ||
      (payeeHit === bestPayeeHit && dist < bestDist)
    ) {
      best = t;
      bestPayeeHit = payeeHit;
      bestDist = dist;
    }
  }

  return best ? { transaction: best } : null;
}

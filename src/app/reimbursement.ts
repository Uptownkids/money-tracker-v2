/**
 * Trip reimbursement tracking (built for the LA trip, Oct 2026).
 *
 * The flow: Malike toggles "Reimbursable" on a trip expense in Quick-Log.
 * The expense is attached to a single open TheyOweMe IOU named
 * "LA trip reimbursement" (created on first use, countOnIt false so it
 * never touches safe-to-spend). The IOU accumulates the running total and
 * every linked expense, so the receipts can be matched line by line.
 *
 * Settling is receipt-driven: the settle sheet lists the linked expenses
 * with checkboxes. Each checked expense becomes a Refund
 * (refundOfTransactionId set) on the receiving account — trip spending
 * nets to zero in Insights and nothing counts as income. Unchecked
 * expenses (rejected receipts) are detached and stay as his own spending.
 *
 * Money model notes:
 * - The split's `amount` is the running claimed total (integer minor
 *   units, single currency — enforced). Like the existing "link an
 *   expense" IOU mode, editing or deleting a linked expense later does
 *   not retro-adjust the total; the itemized list is the receipt source
 *   of truth.
 * - Refunds land on the RECEIVING account (where the reimbursement is
 *   paid), not on the expense's account: a card expense reimbursed into
 *   checking must not pretend the card balance dropped.
 * - Nothing here counts as income: refunds net against expenses, and
 *   countsAsIncome() excludes every settlement row via splitId.
 */
import type { DateOnly } from "../domain/dates/dateOnly.js";
import { addMinor, type MinorUnits } from "../domain/money/money.js";
import { settleIou } from "../domain/engine/ious.js";
import type { Split } from "../domain/entities/split.js";
import type { Transaction } from "../domain/entities/transaction.js";
import type { Repositories } from "../data/repositories/index.js";

/** The single reimbursement IOU this feature manages. */
export const REIMBURSEMENT_IOU_PERSON = "LA trip reimbursement";

/** True for the reimbursement IOU this feature manages. */
export function isReimbursementSplit(split: Split): boolean {
  return (
    split.direction === "TheyOweMe" && split.person === REIMBURSEMENT_IOU_PERSON
  );
}

/** The open reimbursement IOU, if one exists. Pure. */
export function findOpenReimbursementSplit(
  splits: readonly Split[],
): Split | undefined {
  return splits.find((s) => isReimbursementSplit(s) && !s.settled);
}

/** Expenses attached to a reimbursement split (the receipt list). Pure. */
export function linkedReimbursementExpenses(
  transactions: readonly Transaction[],
  splitId: string,
): Transaction[] {
  return transactions
    .filter((t) => t.type === "Expense" && t.splitId === splitId)
    .sort((a, b) =>
      a.date !== b.date
        ? a.date < b.date
          ? -1
          : 1
        : a.createdAt < b.createdAt
          ? -1
          : 1,
    );
}

/**
 * Find the open reimbursement IOU or create it. The split is single
 * currency: a later expense in another currency is rejected loudly rather
 * than silently mis-summed.
 */
export async function getOrCreateReimbursementSplit(
  repos: Repositories,
  currency: string,
  nowIso: string,
): Promise<Split> {
  const splits = await repos.splits.getAll();
  const open = findOpenReimbursementSplit(splits);
  if (open) {
    if (open.currency !== currency) {
      throw new Error(
        `The reimbursement IOU is in ${open.currency} — this expense is in ${currency}, so it can't be added.`,
      );
    }
    return open;
  }
  const split: Split = {
    id: crypto.randomUUID(),
    linkedTransactionId: "",
    person: REIMBURSEMENT_IOU_PERSON,
    amount: 0 as MinorUnits,
    currency,
    direction: "TheyOweMe",
    settled: false,
    // Never counted in safe-to-spend: the money isn't his until it's paid.
    countOnIt: false,
    createdAt: nowIso,
  };
  await repos.splits.put(split);
  return split;
}

/**
 * Attach a saved expense to the reimbursement IOU: the split's running
 * total grows by the expense amount and the expense row points at the
 * split. The expense must already be persisted.
 */
export async function attachExpenseToReimbursement(
  repos: Repositories,
  splitId: string,
  tx: Transaction,
): Promise<Split> {
  if (tx.type !== "Expense") {
    throw new Error("Only expenses can be marked reimbursable.");
  }
  const split = await repos.splits.getById(splitId);
  if (!split || !isReimbursementSplit(split) || split.settled) {
    throw new Error("The reimbursement IOU is no longer open.");
  }
  if (split.currency !== tx.currency) {
    throw new Error(
      `The reimbursement IOU is in ${split.currency} — this expense is in ${tx.currency}, so it can't be added.`,
    );
  }
  const updatedTx: Transaction = {
    ...tx,
    splitId: split.id,
    updatedAt: new Date().toISOString(),
  };
  const updatedSplit: Split = {
    ...split,
    amount: addMinor(split.amount, tx.amount),
  };
  await repos.transactions.put(updatedTx);
  await repos.splits.put(updatedSplit);
  return updatedSplit;
}

export interface ReimbursementRefundInput {
  split: Split;
  expense: Transaction;
  /** Account the reimbursement lands in. */
  receivingAccountId: string;
  receivingCurrency: string;
  date: DateOnly;
  nowIso: string;
}

/**
 * Build one settlement Refund for a single reimbursed expense — pure.
 * The refund lands on the receiving account (money back in, never
 * income) and nets against the expense's category via
 * refundOfTransactionId, so Insights spending for the trip goes to zero.
 */
export function buildReimbursementRefund(
  input: ReimbursementRefundInput,
): Transaction {
  const { split, expense, receivingAccountId, receivingCurrency, date, nowIso } =
    input;
  return {
    id: crypto.randomUUID(),
    type: "Refund",
    amount: expense.amount,
    currency: receivingCurrency,
    date,
    accountId: receivingAccountId,
    categoryId: expense.categoryId,
    payee: REIMBURSEMENT_IOU_PERSON,
    status: "Cleared",
    notes: `Reimbursement for "${expense.payee}" on ${expense.date}`,
    tags: [],
    refundOfTransactionId: expense.id,
    splitId: split.id,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export interface SettleReimbursementInput {
  splitId: string;
  /** Expense ids the reimbursement actually covers (checked in the sheet). */
  coveredExpenseIds: readonly string[];
  receivingAccountId: string;
  date: DateOnly;
  nowIso: string;
}

export interface SettleReimbursementResult {
  refunds: Transaction[];
  /** Expenses that stay as his own spending (unchecked / rejected). */
  keptAsSpending: Transaction[];
}

/**
 * Settle the reimbursement IOU. One Refund per covered expense, on the
 * receiving account; uncovered expenses are detached from the IOU and
 * stay as ordinary spending. The split is marked settled with its amount
 * set to what was actually reimbursed.
 */
export async function settleReimbursement(
  repos: Repositories,
  input: SettleReimbursementInput,
): Promise<SettleReimbursementResult> {
  const { splitId, coveredExpenseIds, receivingAccountId, date, nowIso } = input;
  const split = await repos.splits.getById(splitId);
  if (!split || !isReimbursementSplit(split) || split.settled) {
    throw new Error("The reimbursement IOU is no longer open.");
  }
  const account = await repos.accounts.getById(receivingAccountId);
  if (!account) {
    throw new Error("Pick an account for the reimbursement.");
  }
  if (account.currency !== split.currency) {
    throw new Error(
      `Pick a ${split.currency} account — ${account.name} is in ${account.currency}.`,
    );
  }
  const transactions = await repos.transactions.getAll();
  const linked = linkedReimbursementExpenses(transactions, split.id);
  const covered = new Set(coveredExpenseIds);
  const coveredTxs = linked.filter((t) => covered.has(t.id));
  const keptTxs = linked.filter((t) => !covered.has(t.id));

  const refunds = coveredTxs.map((expense) =>
    buildReimbursementRefund({
      split,
      expense,
      receivingAccountId: account.id,
      receivingCurrency: account.currency,
      date,
      nowIso,
    }),
  );
  for (const r of refunds) {
    await repos.transactions.put(r);
  }
  // Rejected receipts stay as his own spending, detached from the IOU.
  for (const t of keptTxs) {
    const { splitId: _dropped, ...rest } = t;
    await repos.transactions.put({
      ...rest,
      updatedAt: nowIso,
    });
  }
  const reimbursedTotal = coveredTxs.reduce(
    (sum, t) => addMinor(sum, t.amount),
    0 as MinorUnits,
  );
  await repos.splits.put(
    settleIou({ ...split, amount: reimbursedTotal }, nowIso),
  );
  return { refunds, keptAsSpending: keptTxs };
}

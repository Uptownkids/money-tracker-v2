/**
 * Balance-correction writers: turn an AdjustDecision into real ledger
 * rows. The pure decision lives in decideAdjust (utils/deepLink); these
 * functions perform the writes. ONE implementation serves both the
 * ?adjust= deep link and inbox "adjust" entries — never duplicated.
 *
 * - unlogged-spending: one Expense, Uncategorized, payee "Unlogged spending".
 * - money-appeared (asset accounts): the user picks one of four —
 *   Refund (money back in, never income), IOU repayment (a real TheyOweMe
 *   split created and immediately settled through the normal settle path),
 *   forgotten income (plain Income), or just-correct (Income tagged with
 *   BALANCE_CORRECTION_TAG so countsAsIncome() excludes it).
 * - correction (card/loan paydown): same tagged Income as just-correct.
 *
 * Nothing here overwrites a balance; every option records the difference
 * as a transaction.
 */
import type { DateOnly } from "../domain/dates/dateOnly.js";
import type { MinorUnits } from "../domain/money/money.js";
import type { Repositories } from "../data/repositories/index.js";
import { saveQuickLog } from "./quickLog.js";
import {
  BALANCE_CORRECTION_TAG,
  type Transaction,
} from "../domain/entities/transaction.js";
import type { Category, CategoryKind } from "../domain/entities/category.js";
import type { Split } from "../domain/entities/split.js";
import { buildSettlementTransaction, settleIou } from "../domain/engine/ious.js";

export interface AdjustTarget {
  accountId: string;
  currency: string;
  date: DateOnly; // usually today
  nowIso: string;
}

const UNCATEGORIZED = "Uncategorized";

/**
 * Find or create the catch-all category for balance corrections.
 * Unlogged money must never pollute a real category, so: prefer an
 * existing "Uncategorized" of the right kind; for income, a category
 * literally named "Income" is an acceptable home too; otherwise create
 * a fresh "Uncategorized". Never hijacks an unrelated category.
 */
export async function ensureCorrectionCategory(
  repos: Repositories,
  kind: CategoryKind,
): Promise<string> {
  const cats = await repos.categories.getAll();
  const live = cats.filter((c) => !c.archived && c.kind === kind);
  const uncategorized = live.find(
    (c) => c.name.trim().toLowerCase() === UNCATEGORIZED.toLowerCase(),
  );
  if (uncategorized) return uncategorized.id;
  if (kind === "income") {
    const income = live.find((c) => c.name.trim().toLowerCase() === "income");
    if (income) return income.id;
  }
  const created: Category = {
    id: crypto.randomUUID(),
    name: UNCATEGORIZED,
    kind,
    icon: "dots",
    color: "slate",
    archived: false,
  };
  await repos.categories.put(created);
  return created.id;
}

/** Money missing: one Expense, Uncategorized, "Unlogged spending". */
export async function applyUnloggedSpending(
  repos: Repositories,
  target: AdjustTarget,
  differenceMinor: MinorUnits,
): Promise<Transaction> {
  const categoryId = await ensureCorrectionCategory(repos, "expense");
  const { transaction } = await saveQuickLog(repos, {
    type: "Expense",
    amountMinor: differenceMinor,
    accountId: target.accountId,
    categoryId,
    payee: "Unlogged spending",
    date: target.date,
  });
  return transaction;
}

export type MoneyAppearedChoice =
  | "refund"
  | "iou-repayment"
  | "forgotten-income"
  | "just-correct";

/**
 * Money appeared in an asset account: record the difference according to
 * the user's choice. iou-repayment requires a person; forgotten-income
 * takes an optional payee (defaults to "Forgotten income").
 */
export async function applyMoneyAppeared(
  repos: Repositories,
  target: AdjustTarget,
  differenceMinor: MinorUnits,
  choice: MoneyAppearedChoice,
  person?: string,
): Promise<Transaction> {
  const { accountId, currency, date, nowIso } = target;

  if (choice === "refund") {
    const tx: Transaction = {
      id: crypto.randomUUID(),
      type: "Refund",
      amount: differenceMinor,
      currency,
      date,
      accountId,
      categoryId: await ensureCorrectionCategory(repos, "expense"),
      payee: "Refund",
      status: "Cleared",
      notes: "",
      tags: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await repos.transactions.put(tx);
    return tx;
  }

  if (choice === "iou-repayment") {
    const who = (person ?? "").trim();
    if (who === "") throw new Error("Who repaid you?");
    // A real split, created and immediately settled through the normal
    // settle path — exactly as if he had logged the IOU and settled it.
    // Never invent a splitId on an unrelated row.
    const split: Split = {
      id: crypto.randomUUID(),
      linkedTransactionId: "",
      person: who,
      amount: differenceMinor,
      currency,
      direction: "TheyOweMe",
      settled: false,
      countOnIt: false,
      createdAt: nowIso,
    };
    await repos.splits.put(split);
    const tx = buildSettlementTransaction({
      split,
      accountId,
      date,
      nowIso,
      linkedExpense: undefined,
    });
    await repos.transactions.put(tx);
    await repos.splits.put(settleIou(split, nowIso));
    return tx;
  }

  const categoryId = await ensureCorrectionCategory(repos, "income");
  if (choice === "forgotten-income") {
    const payee = (person ?? "").trim() === "" ? "Forgotten income" : (person as string).trim();
    const { transaction } = await saveQuickLog(repos, {
      type: "Income",
      amountMinor: differenceMinor,
      accountId,
      categoryId,
      payee,
      date,
    });
    return transaction;
  }

  // just-correct: honest money movement, never earned income.
  const { transaction } = await saveQuickLog(repos, {
    type: "Income",
    amountMinor: differenceMinor,
    accountId,
    categoryId,
    payee: "Balance correction",
    date,
    tags: [BALANCE_CORRECTION_TAG],
  });
  return transaction;
}

/**
 * Card/loan paydown (owed went down): correction inflow, never income —
 * the same tagged mechanism as "just correct the balance".
 */
export async function applyCardCorrection(
  repos: Repositories,
  target: AdjustTarget,
  differenceMinor: MinorUnits,
): Promise<Transaction> {
  return applyMoneyAppeared(repos, target, differenceMinor, "just-correct");
}

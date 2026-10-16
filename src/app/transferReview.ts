/**
 * Transfer review: resolve Expenses filed under the Transfer category.
 *
 * Each miscategorized row is either a real transfer recorded as an
 * expense (the destination account never got the money) or real spending
 * with the wrong category. Two resolutions:
 *
 * - "Transfer to one of my accounts": convert the row to a real Transfer
 *   (type Transfer, destination set, category cleared). Balances are
 *   derived, so both sides update.
 * - "Payment to someone": pick the real category; the row stays an
 *   Expense.
 *
 * Until reviewed, these rows count as spending exactly like any other
 * expense — nothing is silently hidden.
 */
import type { Repositories } from "../data/repositories/index.js";
import type { Transaction } from "../domain/entities/transaction.js";

/**
 * Convert a miscategorized Expense into a real Transfer to `toAccountId`.
 * The source account keeps its -amount; the destination gains +amount
 * (which it was missing while the row was an Expense). Throws when the
 * row isn't an Expense, the destination is unknown, or it's the same
 * account as the source.
 */
export async function convertExpenseToTransfer(
  repos: Repositories,
  transactionId: string,
  toAccountId: string,
): Promise<Transaction> {
  const t = await repos.transactions.getById(transactionId);
  if (!t) {
    throw new Error(`convertExpenseToTransfer: unknown transaction "${transactionId}"`);
  }
  if (t.type !== "Expense") {
    throw new Error(`convertExpenseToTransfer: transaction "${transactionId}" is not an Expense`);
  }
  const dest = await repos.accounts.getById(toAccountId);
  if (!dest || dest.archived) {
    throw new Error(`convertExpenseToTransfer: unknown destination account "${toAccountId}"`);
  }
  if (t.accountId === toAccountId) {
    throw new Error("Pick a different account than the one the money left.");
  }
  const converted: Transaction = {
    ...t,
    type: "Transfer",
    transferToAccountId: dest.id,
    categoryId: null,
    updatedAt: new Date().toISOString(),
  };
  await repos.transactions.put(converted);
  return converted;
}

/**
 * Recategorize a miscategorized Expense: it stays an Expense with the
 * picked category ("Payment to someone"). The Transfer category itself
 * is rejected — that would leave the row unresolved.
 */
export async function recategorizeExpense(
  repos: Repositories,
  transactionId: string,
  categoryId: string | null,
  isTransferCategory: (id: string) => boolean,
): Promise<Transaction> {
  const t = await repos.transactions.getById(transactionId);
  if (!t) {
    throw new Error(`recategorizeExpense: unknown transaction "${transactionId}"`);
  }
  if (t.type !== "Expense") {
    throw new Error(`recategorizeExpense: transaction "${transactionId}" is not an Expense`);
  }
  if (categoryId != null) {
    const cat = await repos.categories.getById(categoryId);
    if (!cat || cat.archived) {
      throw new Error(`recategorizeExpense: unknown category "${categoryId}"`);
    }
    if (isTransferCategory(cat.id)) {
      throw new Error("Pick a real spending category, not Transfer.");
    }
  }
  const updated: Transaction = {
    ...t,
    categoryId,
    updatedAt: new Date().toISOString(),
  };
  await repos.transactions.put(updated);
  return updated;
}

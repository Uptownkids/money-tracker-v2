import type { Transaction } from "./transaction.js";

export type CategoryKind = "income" | "expense";

export interface Category {
  id: string;
  name: string;
  kind: CategoryKind;
  icon: string; // icon key, not an emoji character
  color: string; // token name, paired with sign/icon in UI for colourblind use
  archived: boolean;
}

/** Default categories shipped with the app. All are user-editable. */
export const DEFAULT_CATEGORIES: ReadonlyArray<{
  name: string;
  kind: CategoryKind;
  icon: string;
  color: string;
}> = [
  { name: "Food", kind: "expense", icon: "utensils", color: "emerald" },
  { name: "Housing", kind: "expense", icon: "home", color: "blue" },
  { name: "Transit", kind: "expense", icon: "train", color: "blue" },
  { name: "Entertainment", kind: "expense", icon: "ticket", color: "violet" },
  { name: "Utilities", kind: "expense", icon: "plug", color: "amber" },
  { name: "Health", kind: "expense", icon: "heart", color: "rose" },
  { name: "Shopping", kind: "expense", icon: "bag", color: "violet" },
  { name: "Coffee", kind: "expense", icon: "coffee", color: "amber" },
  { name: "Income", kind: "income", icon: "arrow-down-circle", color: "emerald" },
  { name: "Transfer", kind: "expense", icon: "arrow-left-right", color: "slate" },
  { name: "Other", kind: "expense", icon: "dots", color: "slate" },
];

/**
 * IDs of categories that represent transfers rather than spending.
 * Matches the seeded "Transfer" category by id or by case-insensitive
 * name, so it survives renames and delete-and-recreate. Spending
 * aggregations must exclude these: transfers are never spending, in any
 * chart.
 */
export function transferCategoryIds(categories: readonly Category[]): Set<string> {
  const ids = new Set<string>();
  for (const c of categories) {
    if (c.id === "cat-transfer" || c.name.trim().toLowerCase() === "transfer") {
      ids.add(c.id);
    }
  }
  return ids;
}

/**
 * Expenses filed under a Transfer category. These are data to fix, not
 * data to hide: each one is either a real transfer recorded as an
 * expense (the destination account never got the money) or real spending
 * with the wrong category. Until reviewed they count as spending; the
 * Transfer review flow resolves each one.
 */
export function findTransferCategoryExpenses(
  transactions: readonly Transaction[],
  categories: readonly Category[],
): Transaction[] {
  const transferCats = transferCategoryIds(categories);
  return transactions.filter(
    (t) => t.type === "Expense" && t.categoryId != null && transferCats.has(t.categoryId),
  );
}

/**
 * Expense categories offered in pickers for new/edited entries: kind
 * expense, never the Transfer category. Real transfers always use the
 * Transfer transaction type, so the category must not be pickable —
 * otherwise the destination balance never updates.
 */
export function expenseCategories(categories: readonly Category[]): Category[] {
  const transferCats = transferCategoryIds(categories);
  return categories.filter((c) => c.kind === "expense" && !transferCats.has(c.id));
}

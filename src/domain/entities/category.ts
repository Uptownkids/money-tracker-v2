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

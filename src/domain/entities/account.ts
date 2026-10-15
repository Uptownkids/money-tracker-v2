import type { DateOnly } from "../dates/dateOnly.js";
import type { MinorUnits } from "../money/money.js";

export type AccountType = "Checking" | "Savings" | "Cash" | "CreditCard" | "Loan" | "Other";

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  startingBalance: MinorUnits; // balance on startingDate, before transactions
  startingDate: DateOnly;
  // Default: true for Checking and Cash, false for everything else
  // (Savings, CreditCard, Loan, Other). See defaultCountsAsSpendable.
  // Credit cards and loans are liabilities: their balance is what is owed.
  countsAsSpendable: boolean;
  // Optional rate used when this account's balance is summed into
  // base-currency totals (safe-to-spend, net worth). When unset, the
  // calculator falls back to the last-used rate for that currency pair.
  fxRateToBase?: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A credit-card or loan balance is money owed: always stored negative (or zero). */
export function isLiabilityAccount(a: Account): boolean {
  return a.type === "CreditCard" || a.type === "Loan";
}

/** Default countsAsSpendable for a new account: only Checking and Cash. */
export function defaultCountsAsSpendable(type: AccountType): boolean {
  return type === "Checking" || type === "Cash";
}

/**
 * Normalize an entered starting balance for storage. Onboarding and
 * migration accept the amount owed on a credit card or loan as a
 * positive number; it is stored negative (a liability). All other
 * account types store the entered amount as-is.
 */
export function toStoredBalance(type: AccountType, enteredMinor: MinorUnits): MinorUnits {
  if (!Number.isInteger(enteredMinor)) {
    throw new TypeError("toStoredBalance: amount must be an integer");
  }
  return type === "CreditCard" || type === "Loan" ? -Math.abs(enteredMinor) : enteredMinor;
}

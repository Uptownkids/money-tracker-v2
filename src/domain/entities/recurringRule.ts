import type { DateOnly, WeekendShift } from "../dates/dateOnly.js";
import type { MinorUnits } from "../money/money.js";

export type RecurringKind = "Income" | "Bill" | "Subscription";
export type Frequency = "weekly" | "biweekly" | "semi-monthly" | "monthly" | "annual" | "custom";

export interface RecurringRule {
  id: string;
  kind: RecurringKind;
  name: string;
  amount: MinorUnits;
  currency: string;
  accountId: string;
  categoryId: string;
  frequency: Frequency;
  customIntervalDays?: number; // for frequency: "custom"
  // Semi-monthly only: the days of the month the rule fires on,
  // e.g. [15, 30]. Values past month-end clamp to the last day.
  daysOfMonth?: number[];
  nextDueDate: DateOnly;
  weekendShift: WeekendShift; // default "previous-business-day" for paydays
  autoPay: boolean;
  reminderOffsetDays: number; // default 3

  // Rule end (debt payoff plans, fixed-term bills)
  endDate?: DateOnly;
  remainingOccurrences?: number;
  // True when the amount is an estimate (utilities); the generated
  // Scheduled row invites confirmation of the actual amount.
  isVariableAmount?: boolean;

  // Income only: the primary payday defines the pay cycle for Today.
  isPrimaryPayday?: boolean;
  // Legacy label for a rule whose job is paying a credit card. Kept for
  // older rules and the Bills sheet; it no longer changes any math —
  // card and loan payments are treated identically (minimum due in
  // committed, no balance subtracted from available).
  isCreditCardPayment?: boolean;

  // Debt-payment rules: paying a credit card or a loan. The presence of
  // `payToAccountId` IS the debt-payment identity — no separate loan flag
  // (the destination account's type already says whether it is a card or
  // a loan). Occurrences generate Transfer rows (source account ->
  // payToAccountId, categoryId null), never Expenses. Required whenever
  // the rule is a debt payment; the Bills sheet blocks save without it.
  payToAccountId?: string;

  // Bills only
  lateFeeAmount?: MinorUnits;

  // Subscriptions only
  unusedFlag?: boolean; // "Unused / Cancel?" prompt in Today's Moves

  // Engine bookkeeping
  skippedDates: DateOnly[]; // occurrences skipped by the user
  lastGeneratedThrough?: DateOnly; // catch-up watermark per rule

  // --- Auto-detected recurring (Phase B2) ---
  /** Merchant key this rule was auto-created from (import detection). */
  merchantKey?: string;
  /** True when the import engine created this rule automatically. */
  autoCreated?: boolean;
  autoCreatedAt?: string;

  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// Single-occurrence override, keyed by ruleId + occurrenceDate. Used for
// "this occurrence only" edits (amount, date, account) without touching
// the rule or future occurrences.
export interface RecurringOverride {
  id: string; // `${ruleId}:${occurrenceDate}`
  ruleId: string;
  occurrenceDate: DateOnly;
  amount?: MinorUnits;
  date?: DateOnly;
  accountId?: string;
  categoryId?: string;
  createdAt: string;
}

export function overrideId(ruleId: string, occurrenceDate: DateOnly): string {
  return `${ruleId}:${occurrenceDate}`;
}

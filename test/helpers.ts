/** Test factories: minimal valid entities with sensible defaults. */
import type { Account } from "../src/domain/entities/account.js";
import type { Category } from "../src/domain/entities/category.js";
import type { Transaction } from "../src/domain/entities/transaction.js";
import type { Goal } from "../src/domain/entities/goal.js";
import type { RecurringRule, RecurringOverride } from "../src/domain/entities/recurringRule.js";
import type { Split } from "../src/domain/entities/split.js";
import type { DateOnly } from "../src/domain/dates/dateOnly.js";

let seq = 0;
const uid = (p: string) => `${p}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
const NOW = "2026-10-15T12:00:00.000Z";

export function mkAccount(o: Partial<Account> = {}): Account {
  return {
    id: uid("acct"),
    name: "Checking",
    type: "Checking",
    currency: "USD",
    startingBalance: 0,
    startingDate: "2026-01-01",
    countsAsSpendable: true,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...o,
  };
}

export function mkCategory(o: Partial<Category> = {}): Category {
  return {
    id: uid("cat"),
    name: "Food",
    kind: "expense",
    icon: "utensils",
    color: "emerald",
    archived: false,
    ...o,
  };
}

export function mkTransaction(o: Partial<Transaction> = {}): Transaction {
  return {
    id: uid("tx"),
    type: "Expense",
    amount: 100,
    currency: "USD",
    date: "2026-10-15",
    accountId: "acct-1",
    categoryId: "cat-1",
    payee: "Test payee",
    status: "Cleared",
    notes: "",
    tags: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...o,
  };
}

export function mkRule(o: Partial<RecurringRule> = {}): RecurringRule {
  return {
    id: uid("rule"),
    kind: "Bill",
    name: "Test bill",
    amount: 1000,
    currency: "USD",
    accountId: "acct-1",
    categoryId: "cat-1",
    frequency: "monthly",
    nextDueDate: "2026-10-15" as DateOnly,
    weekendShift: "none",
    autoPay: false,
    reminderOffsetDays: 3,
    skippedDates: [],
    active: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...o,
  };
}

export function mkOverride(o: Partial<RecurringOverride> = {}): RecurringOverride {
  return {
    id: uid("ov"),
    ruleId: "rule-1",
    occurrenceDate: "2026-10-15" as DateOnly,
    createdAt: NOW,
    ...o,
  };
}

export function mkGoal(o: Partial<Goal> = {}): Goal {
  return {
    id: uid("goal"),
    name: "Test goal",
    targetAmount: 10000,
    currency: "USD",
    targetDate: "2027-01-15" as DateOnly,
    contributionPerCycleOverride: undefined,
    pinnedContribution: null,
    priority: 2,
    paused: false,
    completed: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...o,
  };
}

export function mkSplit(o: Partial<Split> = {}): Split {
  return {
    id: uid("split"),
    linkedTransactionId: "tx-1",
    person: "Sam",
    amount: 5000,
    currency: "USD",
    direction: "TheyOweMe",
    settled: false,
    countOnIt: false,
    createdAt: NOW,
    ...o,
  };
}

export const ACCTS = (list: Account[]) => new Map(list.map((a) => [a.id, a]));

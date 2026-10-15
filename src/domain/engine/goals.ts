/**
 * Goal math: derived saved amounts, earmarking, and per-cycle contributions.
 *
 * Nothing about a goal is stored except its definition. Saved amounts,
 * earmarked amounts, and contributions are all derived from transactions.
 */
import type { DateOnly } from "../dates/dateOnly.js";
import { addDays, compareDateOnly } from "../dates/dateOnly.js";
import type { MinorUnits } from "../money/money.js";
import { divCeil, maxZero, subMinor, sumMinor } from "../money/money.js";
import type { Account } from "../entities/account.js";
import type { Goal } from "../entities/goal.js";
import type { Transaction } from "../entities/transaction.js";
import { affectsBalance, isSelfTransfer } from "../entities/transaction.js";

/**
 * Converts one transaction's effective amount to base currency. Callers
 * that aggregate across accounts (committed, safe-to-spend) pass a real
 * converter; single-currency callers may omit it and get the raw
 * account-currency amount (fx.baseAmount when present).
 */
export type GoalTxToBase = (t: Transaction) => MinorUnits;

const rawTxAmount: GoalTxToBase = (t) => (t.fx ? t.fx.baseAmount : t.amount);

export type AccountsById = ReadonlyMap<string, Account>;

function isSpendable(accountsById: AccountsById, accountId: string): boolean {
  return accountsById.get(accountId)?.countsAsSpendable ?? false;
}

/** Goal transactions in chronological order (date, then createdAt). */
function goalTransactionsSorted(
  goalId: string,
  transactions: readonly Transaction[],
): Transaction[] {
  return transactions
    .filter((t) => t.goalId === goalId && affectsBalance(t))
    .sort((a, b) => compareDateOnly(a.date, b.date) || (a.createdAt < b.createdAt ? -1 : 1));
}

/**
 * Plain signed sum of a goal's Cleared/Pending transactions.
 * Transfer with goalId: +amount (allocation to the goal).
 * Expense with goalId: -amount. Income/Refund with goalId: +amount.
 * Used for progress bars. Optionally cut off at asOfDateExclusive
 * (transactions with date < asOfDateExclusive only).
 */
export function deriveGoalSaved(
  goalId: string,
  transactions: readonly Transaction[],
  asOfDateExclusive?: DateOnly,
  toBase: GoalTxToBase = rawTxAmount,
): MinorUnits {
  let total = 0;
  for (const t of transactions) {
    if (t.goalId !== goalId || !affectsBalance(t)) continue;
    if (asOfDateExclusive && compareDateOnly(t.date, asOfDateExclusive) >= 0) continue;
    const amt = toBase(t);
    total = t.type === "Expense" ? total - amt : total + amt;
  }
  return total;
}

/**
 * Money earmarked for the goal that is still sitting in spendable
 * accounts. Chronological running total, floored at 0 after every step
 * so it can never go negative:
 * - self-transfer in a spendable account, or transfer in from a
 *   non-spendable account: +amount
 * - transfer from spendable to non-spendable: -amount
 * - transfer between two spendable accounts: no change (earmark moves)
 * - goal expense from a spendable account: -amount
 */
export function earmarkedInSpendable(
  goalId: string,
  transactions: readonly Transaction[],
  accountsById: AccountsById,
  toBase: GoalTxToBase = rawTxAmount,
): MinorUnits {
  let running = 0;
  for (const t of goalTransactionsSorted(goalId, transactions)) {
    const amt = toBase(t);
    if (t.type === "Transfer" && t.transferToAccountId) {
      const fromSpendable = isSpendable(accountsById, t.accountId);
      const toSpendable = isSpendable(accountsById, t.transferToAccountId);
      if (isSelfTransfer(t)) {
        if (fromSpendable) running += amt;
      } else if (fromSpendable && !toSpendable) {
        running -= amt;
      } else if (!fromSpendable && toSpendable) {
        running += amt;
      }
      // spendable -> spendable (different accounts): earmark moves, no change
    } else if (t.type === "Expense") {
      if (isSpendable(accountsById, t.accountId)) running -= amt;
    }
    if (running < 0) running = 0;
  }
  return running;
}

/**
 * Transfers with this goalId in [cycleStart, cycleEnd] that fund the goal
 * this cycle: spendable -> non-spendable transfers, plus self-transfers
 * within a spendable account (the unlinked-goal funding mechanism).
 */
export function fundedThisCycle(
  goalId: string,
  transactions: readonly Transaction[],
  cycleStart: DateOnly,
  cycleEnd: DateOnly,
  accountsById: AccountsById,
  toBase: GoalTxToBase = rawTxAmount,
): MinorUnits {
  let total = 0;
  for (const t of transactions) {
    if (t.goalId !== goalId || t.type !== "Transfer" || !affectsBalance(t)) continue;
    if (compareDateOnly(t.date, cycleStart) < 0 || compareDateOnly(t.date, cycleEnd) > 0) continue;
    if (!t.transferToAccountId) continue;
    const amt = toBase(t);
    const fromSpendable = isSpendable(accountsById, t.accountId);
    if (!fromSpendable) continue;
    if (isSelfTransfer(t)) {
      total += amt;
    } else if (!isSpendable(accountsById, t.transferToAccountId)) {
      total += amt;
    }
  }
  return total;
}

/**
 * Planning horizon for a goal's contribution math. A goal with a set
 * target date uses it; a dateless goal plans over 1 year from the
 * cycle start (addDays(cycleStart, 365)).
 */
export function goalTargetDateOrDefault(goal: Goal, cycleStart: DateOnly): DateOnly {
  return goal.targetDate ?? addDays(cycleStart, 365);
}

/**
 * Contribution for a cycle from the saved amount as of the cycle start.
 * Uses the override when set; otherwise ceiling-divides the remaining
 * amount over the cycles left so the target is always reachable.
 * max(1, cyclesRemaining): a goal due before the next payday — or with no
 * payday set at all — commits the full remaining amount this cycle,
 * never 0.
 */
export function computeCycleContribution(
  goal: Goal,
  savedAsOfCycleStart: MinorUnits,
  cyclesRemaining: number,
): MinorUnits {
  if (goal.contributionPerCycleOverride !== undefined) {
    return goal.contributionPerCycleOverride;
  }
  const remaining = subMinor(goal.targetAmount, savedAsOfCycleStart);
  if (remaining <= 0) return 0;
  return divCeil(remaining, Math.max(1, cyclesRemaining));
}

export interface PinnedContributionResolution {
  amount: MinorUnits;
  /** True when the caller must write the fresh pin onto the goal. */
  shouldPin: boolean;
}

/**
 * Resolve this cycle's contribution. Uses the pinned amount when the
 * goal's pin matches this cycle's start date; otherwise computes from
 * the saved amount as of the cycle start. Mid-cycle funding never
 * changes the pinned target.
 */
export function resolvePinnedContribution(
  goal: Goal,
  cycleStart: DateOnly,
  transactions: readonly Transaction[],
  cyclesRemaining: number,
): PinnedContributionResolution {
  if (goal.pinnedContribution && goal.pinnedContribution.cycleStart === cycleStart) {
    return { amount: goal.pinnedContribution.amount, shouldPin: false };
  }
  const savedAsOfStart = deriveGoalSaved(goal.id, transactions, cycleStart);
  return {
    amount: computeCycleContribution(goal, savedAsOfStart, cyclesRemaining),
    shouldPin: true,
  };
}

/**
 * Committed for one goal:
 *   earmarkedInSpendable + max(0, thisCycleContribution - fundedThisCycle)
 * Linked-account goals have earmarkedInSpendable == 0, so only the
 * unfunded remainder commits. Unlinked goals commit the full earmarked
 * amount plus any unfunded remainder.
 */
export function committedPerGoal(
  earmarked: MinorUnits,
  contribution: MinorUnits,
  funded: MinorUnits,
): MinorUnits {
  return earmarked + maxZero(subMinor(contribution, funded));
}

/** Sum of committedPerGoal over active, unpaused goals. */
export function totalGoalCommitment(values: readonly MinorUnits[]): MinorUnits {
  return sumMinor(values);
}

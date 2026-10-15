/**
 * Goal completion and "used, not unsaved" contribution math.
 *
 * - Spending a goal's float (goal-tagged expenses) never triggers a
 *   refill: contributions are computed from funding, not from the signed
 *   saved amount.
 * - A completed goal contributes 0 to committed and is excluded from
 *   contribution math.
 * - A past-due, uncompleted goal raises a "mark complete?" Today's Move.
 */
import { describe, expect, it } from "vitest";
import {
  committedPerGoal,
  countsTowardCommitment,
  deriveGoalFunded,
  deriveGoalSaved,
  resolvePinnedContribution,
  totalGoalCommitment,
} from "../src/domain/engine/goals.js";
import {
  rankTodaysMoves,
  type MovesContext,
} from "../src/domain/engine/todaysMoves.js";
import { mkGoal, mkTransaction } from "./helpers.js";
import type { Goal } from "../src/domain/entities/goal.js";
import type { MinorUnits } from "../src/domain/money/money.js";
import type { DateOnly } from "../src/domain/dates/dateOnly.js";

const TODAY = "2026-10-15" as DateOnly;

function movesCtx(goals: Goal[]): MovesContext {
  return {
    today: TODAY,
    isPaydayToday: false,
    paydayRunCompleted: false,
    scheduledBills: [],
    projectedBills: [],
    rules: [],
    pendingTransactions: [],
    splits: [],
    goals,
  };
}

describe("goal-tagged spending counts as used, not unsaved", () => {
  it("spending the full float does not increase next cycle's contribution", () => {
    const goal = mkGoal({
      id: "g-float",
      name: "LA trip float",
      targetAmount: 57000 as MinorUnits,
      targetDate: "2026-11-15" as DateOnly,
    });
    // Fund the $570 float on Oct 15 (balance-neutral self-transfer).
    const fund = mkTransaction({
      type: "Transfer",
      amount: 57000 as MinorUnits,
      date: "2026-10-15" as DateOnly,
      goalId: "g-float",
      accountId: "cash",
      transferToAccountId: "cash",
    });
    // Spend it all on the trip: food and Ubers.
    const food = mkTransaction({
      type: "Expense",
      amount: 45000 as MinorUnits,
      date: "2026-10-23" as DateOnly,
      goalId: "g-float",
      accountId: "card",
      categoryId: "c-food",
      payee: "Chipotle",
    });
    const uber = mkTransaction({
      type: "Expense",
      amount: 12000 as MinorUnits,
      date: "2026-10-24" as DateOnly,
      goalId: "g-float",
      accountId: "card",
      categoryId: "c-travel",
      payee: "Uber",
    });
    const txs = [fund, food, uber];

    // Progress bars still tell the truth: the money is gone.
    expect(deriveGoalSaved("g-float", txs)).toBe(0);
    // But contribution math sees the funding, not the spending.
    expect(deriveGoalFunded("g-float", txs)).toBe(57000);

    // First cycle pins a real contribution from the funding.
    const first = resolvePinnedContribution(goal, TODAY, [fund], 12);
    expect(first.amount).toBe(4750); // ceil(57000 / 12)

    // Next cycle, after the whole float was spent: no refill.
    const next = resolvePinnedContribution(
      goal,
      "2026-10-30" as DateOnly,
      txs,
      12,
    );
    expect(next.amount).toBe(0);
    expect(next.shouldPin).toBe(true);
  });

  it("partial spending does not refill the spent part either", () => {
    const goal = mkGoal({
      id: "g-float",
      name: "LA trip float",
      targetAmount: 57000 as MinorUnits,
    });
    const fund = mkTransaction({
      type: "Transfer",
      amount: 57000 as MinorUnits,
      date: "2026-10-15" as DateOnly,
      goalId: "g-float",
      accountId: "cash",
      transferToAccountId: "cash",
    });
    const partial = mkTransaction({
      type: "Expense",
      amount: 20000 as MinorUnits,
      date: "2026-10-23" as DateOnly,
      goalId: "g-float",
      accountId: "card",
      categoryId: "c-food",
      payee: "Chipotle",
    });
    const next = resolvePinnedContribution(
      goal,
      "2026-10-30" as DateOnly,
      [fund, partial],
      12,
    );
    // Funded in full already: nothing more to contribute, despite $200 spent.
    expect(next.amount).toBe(0);
  });
});

describe("completed goals", () => {
  it("countsTowardCommitment is false for completed or paused goals", () => {
    expect(countsTowardCommitment(mkGoal({}))).toBe(true);
    expect(countsTowardCommitment(mkGoal({ completed: true }))).toBe(false);
    expect(countsTowardCommitment(mkGoal({ paused: true }))).toBe(false);
  });

  it("a completed goal contributes 0 to committed", () => {
    const active = mkGoal({ id: "g-active", name: "Active" });
    const done = mkGoal({
      id: "g-done",
      name: "Done",
      completed: true,
      targetAmount: 57000 as MinorUnits,
    });
    // Dashboard-style rollup: filter, then committedPerGoal, then total.
    const values = [active, done]
      .filter((g) => countsTowardCommitment(g))
      .map(() => committedPerGoal(0, 4750 as MinorUnits, 0 as MinorUnits));
    expect(totalGoalCommitment(values)).toBe(4750);

    const onlyDone = [done]
      .filter((g) => countsTowardCommitment(g))
      .map(() => committedPerGoal(0, 4750 as MinorUnits, 0 as MinorUnits));
    expect(totalGoalCommitment(onlyDone)).toBe(0);
  });
});

describe("goal-past-due move", () => {
  it("nudges to mark a past-due goal complete", () => {
    const goal = mkGoal({
      id: "g-float",
      name: "LA trip float",
      targetDate: "2026-10-10" as DateOnly,
    });
    const moves = rankTodaysMoves(movesCtx([goal]));
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({
      kind: "goal-past-due",
      priority: 7,
      title: "LA trip float: mark complete?",
      relatedId: "g-float",
      actions: ["snooze", "open"],
    });
  });

  it("never nudges for completed goals, future dates, today, or dateless goals", () => {
    const goals = [
      mkGoal({
        id: "g-done",
        targetDate: "2026-10-10" as DateOnly,
        completed: true,
      }),
      mkGoal({ id: "g-future", targetDate: "2026-10-20" as DateOnly }),
      mkGoal({ id: "g-today", targetDate: TODAY }),
      mkGoal({ id: "g-none", targetDate: undefined }),
    ];
    expect(rankTodaysMoves(movesCtx(goals))).toHaveLength(0);
  });
});

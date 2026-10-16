import { describe, expect, it } from "vitest";
import {
  calculateSafeToSpend,
  computeTodaySpending,
  createDailySnapshot,
  mergeCommittedBills,
  type CurrencyConverter,
  type SafeToSpendInput,
} from "../src/domain/engine/safeToSpend.js";
import {
  committedPerGoal,
  computeCycleContribution,
  deriveGoalSaved,
  earmarkedInSpendable,
  fundedThisCycle,
  resolvePinnedContribution,
} from "../src/domain/engine/goals.js";
import { deriveBalances } from "../src/domain/engine/balances.js";
import { resolvePayCycle } from "../src/domain/dates/payCycle.js";
import type { Account } from "../src/domain/entities/account.js";
import type { MinorUnits } from "../src/domain/money/money.js";
import { ACCTS, mkAccount, mkGoal, mkRule, mkTransaction } from "./helpers.js";
import type { ProjectedOccurrence } from "../src/domain/engine/projection.js";

import { convertMinor } from "../src/domain/money/fx.js";

const USD: CurrencyConverter = (amt, currency, account) => {
  if (currency === "USD") return amt;
  return convertMinor(amt, currency, "USD", account?.fxRateToBase ?? 1);
};

const chk = (id = "chk", startingBalance = 0) =>
  mkAccount({ id, name: "Checking", type: "Checking", startingBalance, countsAsSpendable: true });
const sav = (id = "sav", startingBalance = 0) =>
  mkAccount({ id, name: "Savings", type: "Savings", startingBalance, countsAsSpendable: false });

function baseInput(o: Partial<SafeToSpendInput> = {}): SafeToSpendInput {
  const checking = chk();
  return {
    today: "2026-10-15",
    accounts: [checking],
    balances: { [checking.id]: 100000 },
    projectedBills: [],
    scheduledBills: [],
    goalContributions: 0,
    countedIous: 0,
    buffer: 0,
    todaySpending: 0,
    nextPayday: "2026-10-30",
    baseCurrency: "USD",
    convertToBase: USD,
    ...o,
  };
}

function proj(o: Partial<ProjectedOccurrence> & { ruleId: string }): ProjectedOccurrence {
  return {
    occurrenceDate: "2026-10-20",
    date: "2026-10-20",
    amount: 10000,
    currency: "USD",
    kind: "Bill",
    isDebtPayment: false,
    ...o,
  };
}

describe("calculateSafeToSpend", () => {
  it("computes the normal daily number, rounded down to the unit", () => {
    const r = calculateSafeToSpend(baseInput());
    expect(r.mode).toBe("normal");
    expect(r.available).toBe(100000);
    expect(r.committed).toBe(0);
    expect(r.daysLeft).toBe(15);
    expect(r.dailyAmount).toBe(6600); // floor(100000/15)=6666 -> $66
    expect(r.leftToday).toBe(6600);
  });

  it("subtracts committed bills and buffer", () => {
    const r = calculateSafeToSpend(
      baseInput({
        projectedBills: [proj({ ruleId: "r1", amount: 26400 }), proj({ ruleId: "r2", amount: 6200 })],
        buffer: 5000,
      }),
    );
    expect(r.committed).toBe(26400 + 6200 + 5000);
    // (100000 - 37600) / 15 = 4160 -> $41.60 -> $41
    expect(r.dailyAmount).toBe(4100);
  });

  it("enters deficit mode instead of showing a negative number", () => {
    const r = calculateSafeToSpend(baseInput({ projectedBills: [proj({ ruleId: "r1", amount: 120000 })] }));
    expect(r.mode).toBe("deficit");
    expect(r.dailyAmount).toBe(0);
    expect(r.shortfall).toBe(20000);
    expect(r.leftToday).toBe(0);
  });

  it("uses a labeled 30-day window with no payday", () => {
    const r = calculateSafeToSpend(baseInput({ nextPayday: null }));
    expect(r.mode).toBe("no-payday-window");
    expect(r.daysLeft).toBe(30);
    expect(r.windowLabel).toBe("30-day window (no payday set)");
    expect(r.dailyAmount).toBe(3300); // floor(100000/30)=3333 -> $33
  });

  it("handles payday-is-today via the pay-cycle resolver", () => {
    const rule = mkRule({ kind: "Income", frequency: "semi-monthly", daysOfMonth: [15, 30] });
    const cycle = resolvePayCycle("2026-10-15", rule)!;
    expect(cycle.nextPayday).toBe("2026-10-30");
    const r = calculateSafeToSpend(baseInput({ today: "2026-10-15", nextPayday: cycle.nextPayday }));
    expect(r.daysLeft).toBe(15);
    expect(r.dailyAmount).toBe(6600);
  });

  it("does not subtract card balances from available (minimums model)", () => {
    const checking = chk("chk", 0);
    const card = mkAccount({ id: "cc", name: "Card", type: "CreditCard", startingBalance: 0, countsAsSpendable: false });
    const balances = deriveBalances([checking, card], [
      mkTransaction({ accountId: "chk", type: "Income", amount: 100000, status: "Cleared" }),
      mkTransaction({ accountId: "cc", type: "Expense", amount: 20000, status: "Pending" }),
    ]);
    const r = calculateSafeToSpend(baseInput({ accounts: [checking, card], balances }));
    // The $200 owed stays out of available: only the minimum due is
    // committed (via the card's payment rule), never the full balance.
    expect(r.available).toBe(100000);
    expect(r.dailyAmount).toBe(6600); // floor(100000/15)=6666 -> $66
  });

  it("commits the card minimum like any other bill", () => {
    const card = mkAccount({ id: "cc", name: "Card", type: "CreditCard", startingBalance: -20000, countsAsSpendable: false });
    const r = calculateSafeToSpend(
      baseInput({
        accounts: [chk("chk", 0), card],
        balances: { chk: 100000, cc: -20000 },
        // $47 card minimum projected: set aside, like a loan minimum.
        projectedBills: [proj({ ruleId: "ccpay", amount: 4700, isDebtPayment: true })],
      }),
    );
    expect(r.available).toBe(100000);
    expect(r.committed).toBe(4700);
    expect(r.dailyAmount).toBe(6300); // floor(95300/15)=6353 -> $63
  });

  it("counts overdue bills (projected and scheduled)", () => {
    const scheduled = mkTransaction({
      status: "Scheduled",
      type: "Expense",
      amount: 6200,
      date: "2026-10-10",
      payee: "Internet",
      recurringRuleId: "r2",
      occurrenceDate: "2026-10-10",
    });
    const r = calculateSafeToSpend(
      baseInput({
        projectedBills: [proj({ ruleId: "r1", amount: 26400, date: "2026-10-12", occurrenceDate: "2026-10-12" })],
        scheduledBills: [scheduled],
      }),
    );
    expect(r.committed).toBe(26400 + 6200);
  });

  it("dedupes a projection against its generated Scheduled row", () => {
    const scheduled = mkTransaction({
      status: "Scheduled",
      type: "Expense",
      amount: 26400,
      recurringRuleId: "r1",
      occurrenceDate: "2026-10-20",
    });
    const merged = mergeCommittedBills(
      [proj({ ruleId: "r1", amount: 26400, occurrenceDate: "2026-10-20" })],
      [scheduled],
      USD,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.amount).toBe(26400);
  });

  it("adds counted IOUs to available and converts foreign balances", () => {
    const jpy = mkAccount({ id: "jpy", name: "Yen", currency: "JPY", startingBalance: 10000, countsAsSpendable: true, fxRateToBase: 0.0067 });
    const r = calculateSafeToSpend(
      baseInput({
        accounts: [chk("chk", 0), jpy],
        balances: { chk: 50000, jpy: 10000 },
        countedIous: 20000,
      }),
    );
    // ¥10,000 × 0.0067 = $67.00 -> 6700 minor units
    expect(r.available).toBe(50000 + 6700 + 20000);
  });

  it("derives leftToday from todaySpending", () => {
    expect(calculateSafeToSpend(baseInput({ todaySpending: 2000 })).leftToday).toBe(4600);
    expect(calculateSafeToSpend(baseInput({ todaySpending: 7000 })).leftToday).toBe(-400);
  });

  it("floors daysLeft at 1", () => {
    const r = calculateSafeToSpend(baseInput({ today: "2026-10-30", nextPayday: "2026-10-30" }));
    expect(r.daysLeft).toBe(1);
    expect(r.dailyAmount).toBe(100000);
  });
});

describe("goal math", () => {
  const CYCLE_START = "2026-10-15";
  const CYCLE_END = "2026-10-29";

  it("linked goal funded on payday: committed = 0 (no double count)", () => {
    const checking = chk("chk", 0);
    const savings = sav("sav", 0);
    const accounts = ACCTS([checking, savings]);
    const goal = mkGoal({ id: "g1", name: "Emergency fund", linkedSavingsAccountId: "sav" });
    const fund = mkTransaction({
      type: "Transfer",
      amount: 15000,
      accountId: "chk",
      transferToAccountId: "sav",
      date: "2026-10-15",
      status: "Cleared",
      goalId: "g1",
    });
    const txs = [fund];

    expect(earmarkedInSpendable("g1", txs, accounts)).toBe(0);
    expect(fundedThisCycle("g1", txs, CYCLE_START, CYCLE_END, accounts)).toBe(15000);
    expect(committedPerGoal(0, 15000, 15000)).toBe(0);

    // end to end: the goal is neutral once funded
    const balances = deriveBalances([checking, savings], [
      mkTransaction({ accountId: "chk", type: "Income", amount: 226341, status: "Cleared", date: "2026-10-15" }),
      fund,
    ]);
    const withGoal = calculateSafeToSpend(
      baseInput({
        accounts: [checking, savings],
        balances,
        goalContributions: 0,
        nextPayday: "2026-10-30",
      }),
    );
    const withoutGoal = calculateSafeToSpend(
      baseInput({
        accounts: [checking],
        balances: { chk: 211341 },
        nextPayday: "2026-10-30",
      }),
    );
    expect(withGoal.dailyAmount).toBe(withoutGoal.dailyAmount);
    expect(withGoal.committed).toBe(0);
  });

  it("unlinked goal self-transferred on payday: committed = earmarked only", () => {
    const checking = chk("chk", 0);
    const accounts = ACCTS([checking]);
    const selfTransfer = mkTransaction({
      type: "Transfer",
      amount: 57000,
      accountId: "chk",
      transferToAccountId: "chk",
      date: "2026-10-15",
      status: "Cleared",
      goalId: "g1",
    });
    const txs = [selfTransfer];

    const earmarked = earmarkedInSpendable("g1", txs, accounts);
    const funded = fundedThisCycle("g1", txs, CYCLE_START, CYCLE_END, accounts);
    expect(earmarked).toBe(57000);
    expect(funded).toBe(57000); // self-transfers count in fundedThisCycle
    expect(committedPerGoal(earmarked, 57000, funded)).toBe(57000); // no remainder

    const balances = deriveBalances([checking], [selfTransfer]);
    expect(balances).toEqual({ chk: 0 }); // self-transfer is balance-neutral
    const r = calculateSafeToSpend(
      baseInput({ accounts: [checking], balances: { chk: 100000 }, goalContributions: 57000 }),
    );
    expect(r.committed).toBe(57000);
    expect(r.dailyAmount).toBe(2800); // (100000-57000)/15 = 2866 -> $28
  });

  it("goal spending beyond the earmark clamps earmarked to 0", () => {
    const checking = chk("chk", 0);
    const accounts = ACCTS([checking]);
    const txs = [
      mkTransaction({
        type: "Transfer", amount: 15000, accountId: "chk", transferToAccountId: "chk",
        date: "2026-10-15", status: "Cleared", goalId: "g1",
      }),
      mkTransaction({
        type: "Expense", amount: 20000, accountId: "chk",
        date: "2026-10-16", status: "Cleared", goalId: "g1",
      }),
    ];
    expect(earmarkedInSpendable("g1", txs, accounts)).toBe(0);
  });

  it("deriveGoalSaved sums signed goal transactions", () => {
    const txs = [
      mkTransaction({ type: "Transfer", amount: 15000, accountId: "chk", transferToAccountId: "sav", date: "2026-10-01", status: "Cleared", goalId: "g1" }),
      mkTransaction({ type: "Expense", amount: 2000, accountId: "chk", date: "2026-10-10", status: "Cleared", goalId: "g1" }),
      mkTransaction({ type: "Expense", amount: 999, accountId: "chk", date: "2026-10-20", status: "Scheduled", goalId: "g1" }),
    ];
    expect(deriveGoalSaved("g1", txs)).toBe(13000); // Scheduled excluded
    expect(deriveGoalSaved("g1", txs, "2026-10-10")).toBe(15000); // before Oct 10
  });

  it("pinned contribution is immune to mid-cycle funding", () => {
    const goal = mkGoal({ pinnedContribution: { cycleStart: "2026-10-15", amount: 15000 } });
    const res = resolvePinnedContribution(goal, "2026-10-15", [], 8);
    expect(res).toEqual({ amount: 15000, shouldPin: false });

    // no pin yet: compute from saved-as-of-cycle-start and pin it
    const fresh = mkGoal({ targetAmount: 120000, pinnedContribution: null });
    const res2 = resolvePinnedContribution(fresh, "2026-10-15", [], 8);
    expect(res2).toEqual({ amount: 15000, shouldPin: true }); // ceil(120000/8)
  });

  it("computeCycleContribution honors override and commits full remaining when no cycles left", () => {
    const goal = mkGoal({ targetAmount: 120000, contributionPerCycleOverride: 20000 });
    expect(computeCycleContribution(goal, 0, 8)).toBe(20000);
    const plain = mkGoal({ targetAmount: 120000 });
    expect(computeCycleContribution(plain, 120000, 8)).toBe(0); // already saved
    // Goal due before next payday (or no payday set): full remaining, never 0.
    expect(computeCycleContribution(plain, 0, 0)).toBe(120000);
    expect(computeCycleContribution(mkGoal({ targetAmount: 20000 }), 0, 0)).toBe(20000);
    expect(computeCycleContribution(plain, 1000, 3)).toBe(39667); // ceil(119000/3)
  });
});

describe("createDailySnapshot", () => {
  it("pins the day's number", () => {
    const r = calculateSafeToSpend(baseInput());
    const snap = createDailySnapshot("2026-10-15", r, "2026-10-15T08:00:00.000Z");
    expect(snap).toMatchObject({
      id: "2026-10-15",
      startOfDayAmount: 6600,
      available: 100000,
      committed: 0,
      daysLeft: 15,
    });
  });
});

describe("computeTodaySpending", () => {
  const toBase = (t: { amount: number }) => t.amount as MinorUnits;

  it("excludes transactions settling a recurring occurrence", () => {
    const txs = [
      mkTransaction({ type: "Expense", amount: 876, date: "2026-10-15", status: "Cleared" }),
      // Internet bill marked paid today: already in committed, must not hit Left today.
      mkTransaction({
        type: "Expense", amount: 6200, date: "2026-10-15", status: "Cleared",
        recurringRuleId: "rule-internet", occurrenceDate: "2026-10-10",
      }),
    ];
    expect(computeTodaySpending(txs, "2026-10-15", toBase)).toBe(876);
  });

  it("excludes goal expenses (already earmarked)", () => {
    const txs = [
      mkTransaction({ type: "Expense", amount: 876, date: "2026-10-15", status: "Cleared" }),
      mkTransaction({
        type: "Expense", amount: 5000, date: "2026-10-15", status: "Cleared",
        goalId: "goal-la",
      }),
      // Scheduled and other-day rows never count either.
      mkTransaction({ type: "Expense", amount: 999, date: "2026-10-15", status: "Scheduled" }),
      mkTransaction({ type: "Expense", amount: 999, date: "2026-10-14", status: "Cleared" }),
    ];
    expect(computeTodaySpending(txs, "2026-10-15", toBase)).toBe(876);
  });

  it("counts Expenses filed under a Transfer category until reviewed", () => {
    const txs = [
      mkTransaction({ type: "Expense", amount: 876, date: "2026-10-15", status: "Cleared", categoryId: "cat-food" }),
      mkTransaction({ type: "Expense", amount: 5000, date: "2026-10-15", status: "Cleared", categoryId: "cat-transfer" }),
      mkTransaction({ type: "Transfer", amount: 9000, date: "2026-10-15", status: "Cleared", transferToAccountId: "sav" }),
    ];
    // Transfer TYPE excluded; Transfer-category expense counts as spending.
    expect(computeTodaySpending(txs, "2026-10-15", toBase)).toBe(5876);
  });
});

describe("mergeCommittedBills FX", () => {
  it("converts an fx Scheduled row with the account currency, not the transaction currency", () => {
    const seen: Array<[number, string]> = [];
    const spy: CurrencyConverter = (amt, currency) => {
      seen.push([amt, currency]);
      return amt;
    };
    const scheduled = mkTransaction({
      status: "Scheduled",
      type: "Expense",
      amount: 1000, // EUR as entered
      currency: "EUR",
      accountId: "usd-acct",
      fx: { originalAmount: 1000, originalCurrency: "EUR", rate: 1.08, baseAmount: 1080 },
    });
    const merged = mergeCommittedBills([], [scheduled], spy, () => "USD");
    expect(merged).toHaveLength(1);
    // 1080 is already USD (account currency): must convert as USD, not EUR.
    expect(seen).toEqual([[1080, "USD"]]);
  });
});

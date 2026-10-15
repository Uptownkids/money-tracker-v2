import { describe, expect, it } from "vitest";
import { dollarsToMinor, migrateFromV1, type V1Dashboard } from "../src/data/migration/fromV1.js";
import { generateDueTransactions } from "../src/domain/engine/recurringEngine.js";
import { deriveGoalSaved } from "../src/domain/engine/goals.js";
import { isSelfTransfer } from "../src/domain/entities/transaction.js";

const NOW = "2026-10-15T12:00:00.000Z";

function v1Dashboard(): V1Dashboard {
  return {
    bills: [
      { id: 1, name: "Rent", amount: 1350, due_day: null },
      { id: 2, name: "Internet", amount: 62, due_day: null },
      { id: 3, name: "Phone", amount: 110, due_day: null },
    ],
    debts: [
      { id: 1, name: "Concord", current_balance: 1488.35, minimum_payment: 264, due_day: 11, due_label: "Due Oct 11" },
      { id: 2, name: "Credit One", current_balance: 934.92, minimum_payment: 47, due_day: null, due_label: "Due now" },
      { id: 3, name: "Aspire", current_balance: 485.6, minimum_payment: 321.91, due_day: 28, due_label: "Due Oct 28" },
    ],
    expenses: [
      { id: 12, amount: 16.34, category: "Food", expense_date: "2026-10-14", note: "Lunch" },
      { id: 13, amount: 10.5, category: "Coffee", expense_date: "2026-10-13", note: "Morning coffee" },
    ],
    settings: {
      current_cash: 13,
      savings_per_paycheck: 150,
      savings_goal: 10000,
      paycheck_amount: 2263.41,
      payday_one: 15,
      payday_two: 30,
    },
    savings_total: 0,
    trip_expenses: [{ id: 20, amount: 570, category: "Other", expense_date: "2026-10-14", note: "LA float" }],
    bill_payments: [],
  };
}

describe("migrateFromV1", () => {
  it("maps the full v1 dashboard to v2 entities", () => {
    const res = migrateFromV1(v1Dashboard(), { migrationDate: "2026-10-15", nowIso: NOW });
    expect(res.warnings).toEqual([]);

    // cash account
    const cash = res.accounts.find((a) => a.type === "Cash")!;
    expect(cash.startingBalance).toBe(1300);
    expect(cash.countsAsSpendable).toBe(true);

    // debts -> liability accounts (negative balances)
    const concord = res.accounts.find((a) => a.name === "Concord")!;
    expect(concord.type).toBe("Loan");
    expect(concord.startingBalance).toBe(-148835);
    expect(concord.countsAsSpendable).toBe(false);
    const creditOne = res.accounts.find((a) => a.name === "Credit One")!;
    expect(creditOne.type).toBe("CreditCard");
    expect(creditOne.startingBalance).toBe(-93492);
    const aspire = res.accounts.find((a) => a.name === "Aspire")!;
    expect(aspire.startingBalance).toBe(-48560);

    // minimum-payment rules; only the credit card's is a card payment
    const minimums = res.recurringRules.filter((r) => r.name.endsWith("minimum"));
    expect(minimums).toHaveLength(3);
    expect(minimums.find((r) => r.name === "Concord minimum")!.amount).toBe(26400);
    expect(minimums.find((r) => r.name === "Credit One minimum")!.isCreditCardPayment).toBe(true);
    expect(minimums.find((r) => r.name === "Concord minimum")!.isCreditCardPayment).toBe(false);
    expect(minimums.find((r) => r.name === "Aspire minimum")!.nextDueDate).toBe("2026-10-28");

    // bills -> monthly rules (null due_day -> 1st)
    const rent = res.recurringRules.find((r) => r.name === "Rent")!;
    expect(rent.amount).toBe(135000);
    expect(rent.frequency).toBe("monthly");
    expect(rent.nextDueDate).toBe("2026-11-01");
    expect(rent.accountId).toBe(cash.id);

    // expenses -> Cleared expense transactions on the cash account
    const expenses = res.transactions.filter((t) => t.type === "Expense" && !t.tags.includes("la-trip"));
    expect(expenses).toHaveLength(2);
    expect(expenses[0]).toMatchObject({ amount: 1634, status: "Cleared", accountId: cash.id });
    const trip = res.transactions.find((t) => t.tags.includes("la-trip"))!;
    expect(trip.amount).toBe(57000);

    // goals in deficit-pause priority order
    const payoff = res.goals.find((g) => g.name === "Extra debt payoff")!;
    expect(payoff.targetAmount).toBe(148835 + 93492 + 48560);
    expect(payoff.priority).toBe(1);
    const emergency = res.goals.find((g) => g.name === "Emergency fund")!;
    expect(emergency.targetAmount).toBe(1000000);
    expect(emergency.priority).toBe(2);
    expect(emergency.contributionPerCycleOverride).toBe(15000);
    const laTrip = res.goals.find((g) => g.name === "LA trip float")!;
    expect(laTrip.priority).toBe(3);

    // primary payday rule
    const paycheck = res.recurringRules.find((r) => r.isPrimaryPayday)!;
    expect(paycheck).toMatchObject({
      kind: "Income",
      amount: 226341,
      frequency: "semi-monthly",
      weekendShift: "previous-business-day",
    });
    expect(paycheck.daysOfMonth).toEqual([15, 30]);
    expect(paycheck.nextDueDate).toBe("2026-10-15");
  });

  it("pushes past-due minimums into next month", () => {
    const res = migrateFromV1(v1Dashboard(), { migrationDate: "2026-10-15", nowIso: NOW });
    // Concord due_day 11 already passed on Oct 15 -> next occurrence Nov 11
    const concordMin = res.recurringRules.find((r) => r.name === "Concord minimum")!;
    expect(concordMin.nextDueDate).toBe("2026-11-11");
  });

  it("tags debt minimum rules with the liability account they pay to", () => {
    const res = migrateFromV1(v1Dashboard(), { migrationDate: "2026-10-15", nowIso: NOW });
    const creditOne = res.accounts.find((a) => a.name === "Credit One")!;
    const concord = res.accounts.find((a) => a.name === "Concord")!;
    const aspire = res.accounts.find((a) => a.name === "Aspire")!;
    const creditOneMin = res.recurringRules.find((r) => r.name === "Credit One minimum")!;
    const concordMin = res.recurringRules.find((r) => r.name === "Concord minimum")!;
    const aspireMin = res.recurringRules.find((r) => r.name === "Aspire minimum")!;
    // both the card and the loans carry payToAccountId
    expect(creditOneMin.payToAccountId).toBe(creditOne.id);
    expect(concordMin.payToAccountId).toBe(concord.id);
    expect(aspireMin.payToAccountId).toBe(aspire.id);
    // generated rows are Transfers to the liability account, never expenses
    const gen = generateDueTransactions(creditOneMin, [], [], "2026-10-15", NOW);
    expect(gen.transactions).toHaveLength(1);
    expect(gen.transactions[0]).toMatchObject({
      type: "Transfer",
      transferToAccountId: creditOne.id,
      categoryId: null,
    });
    const loanGen = generateDueTransactions(concordMin, [], [], "2026-11-11", NOW);
    expect(loanGen.transactions).toHaveLength(1);
    expect(loanGen.transactions[0]).toMatchObject({
      type: "Transfer",
      transferToAccountId: concord.id,
      categoryId: null,
    });
  });

  it("honors debt-type overrides", () => {
    const res = migrateFromV1(v1Dashboard(), {
      migrationDate: "2026-10-15",
      nowIso: NOW,
      debtAccountTypes: { Concord: "CreditCard" },
    });
    expect(res.accounts.find((a) => a.name === "Concord")!.type).toBe("CreditCard");
  });

  it("warns on unparseable expense dates instead of dropping silently", () => {
    const v1 = v1Dashboard();
    v1.expenses.push({ id: 99, amount: 5, category: "Food", expense_date: "nonsense", note: "" });
    const res = migrateFromV1(v1, { migrationDate: "2026-10-15", nowIso: NOW });
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("99");
  });

  it("converts dollars to minor units", () => {
    expect(dollarsToMinor(2263.41)).toBe(226341);
    expect(dollarsToMinor(0)).toBe(0);
    expect(() => dollarsToMinor(Number.NaN)).toThrow(RangeError);
  });
});

describe("credit-card balance entry", () => {
  it("accepts the amount owed as a positive number and stores it negative", () => {
    const res = migrateFromV1(v1Dashboard(), { migrationDate: "2026-10-15", nowIso: NOW });
    const creditOne = res.accounts.find((a) => a.name === "Credit One")!;
    expect(creditOne.type).toBe("CreditCard");
    // v1 carried 934.92 (positive, amount owed) -> stored as -93492
    expect(creditOne.startingBalance).toBe(-93492);
    expect(creditOne.startingBalance).toBeLessThan(0);
  });
});

describe("LA trip float migration", () => {
  const opts = { migrationDate: "2026-10-15", nowIso: NOW } as const;

  it("creates a fixed $570 goal when trip expenses exist", () => {
    const res = migrateFromV1(v1Dashboard(), {
      ...opts,
      tripGoal: { targetDate: "2026-10-22", setAsideMinor: 0 },
    });
    const goal = res.goals.find((g) => g.name === "LA trip float")!;
    expect(goal.targetAmount).toBe(57000);
    expect(goal.priority).toBe(3);
    expect(goal.targetDate).toBe("2026-10-22");
    expect(goal.currency).toBe("USD");
    // setAside 0 -> goal but no transfer
    expect(res.transactions.some((t) => t.type === "Transfer" && t.goalId === goal.id)).toBe(false);
  });

  it("leaves targetDate undefined when the user skips the leave date", () => {
    const res = migrateFromV1(v1Dashboard(), opts);
    const goal = res.goals.find((g) => g.name === "LA trip float")!;
    expect(goal.targetDate).toBeUndefined();
  });

  it("creates a balance-neutral self-transfer when set aside is positive", () => {
    const res = migrateFromV1(v1Dashboard(), {
      ...opts,
      tripGoal: { targetDate: "2026-10-22", setAsideMinor: 20000 },
    });
    const goal = res.goals.find((g) => g.name === "LA trip float")!;
    const cash = res.accounts.find((a) => a.type === "Cash")!;
    const txs = res.transactions.filter((t) => t.type === "Transfer" && t.goalId === goal.id);
    expect(txs).toHaveLength(1);
    const tx = txs[0]!;
    expect(tx).toMatchObject({
      amount: 20000,
      accountId: cash.id,
      transferToAccountId: cash.id,
      categoryId: null,
      status: "Cleared",
      date: "2026-10-15",
      goalId: goal.id,
    });
    expect(tx.payee).toContain("LA trip");
    expect(isSelfTransfer(tx)).toBe(true);
    // balance-neutral: one account appears on both sides of the same row
    expect(tx.accountId).toBe(tx.transferToAccountId);
    // the engine counts it as earmarked for the goal
    expect(deriveGoalSaved(goal.id, res.transactions)).toBe(20000);
  });

  it("trip expense amounts do not change the fixed target", () => {
    const v1 = v1Dashboard();
    // trip total is now $1570; the goal must stay at $570
    v1.trip_expenses.push({ id: 21, amount: 1000, category: "Food", expense_date: "2026-10-14", note: "extra" });
    const res = migrateFromV1(v1, opts);
    const goal = res.goals.find((g) => g.name === "LA trip float")!;
    expect(goal.targetAmount).toBe(57000);
    // expenses are still migrated as normal la-trip expenses
    const tripTx = res.transactions.filter((t) => t.tags.includes("la-trip"));
    expect(tripTx).toHaveLength(2);
    expect(tripTx.map((t) => t.amount).sort((a, b) => a - b)).toEqual([57000, 100000]);
  });

  it("creates no goal and no transfer when there are no trip expenses", () => {
    const v1 = v1Dashboard();
    v1.trip_expenses = [];
    const res = migrateFromV1(v1, { ...opts, tripGoal: { setAsideMinor: 20000 } });
    expect(res.goals.some((g) => g.name === "LA trip float")).toBe(false);
    expect(res.transactions.some((t) => t.type === "Transfer")).toBe(false);
  });
});

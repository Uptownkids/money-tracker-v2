/**
 * Debt payments (credit-card and loan) are Transfers, never Expenses.
 * Identity is keyed on the rule's payToAccountId: when set, the engine
 * generates Transfer rows to that account. Only CARD payments are excluded
 * from committed in safe-to-spend (the card balance is already subtracted
 * from available, so counting the payment again would double-count).
 * Loan payments stay in committed: loan balances are NOT subtracted from
 * available, so the minimum must be set aside.
 */
import { describe, expect, it } from "vitest";
import { generateDueTransactions } from "../src/domain/engine/recurringEngine.js";
import { isCardPaymentRule, projectOccurrences } from "../src/domain/engine/projection.js";
import { deriveBalances } from "../src/domain/engine/balances.js";
import {
  calculateSafeToSpend,
  computeTodaySpending,
  type CurrencyConverter,
  type SafeToSpendInput,
} from "../src/domain/engine/safeToSpend.js";
import { settleCardPayment } from "../src/domain/engine/paydayRun.js";
import type { Account } from "../src/domain/entities/account.js";
import type { Transaction } from "../src/domain/entities/transaction.js";
import type { MinorUnits } from "../src/domain/money/money.js";
import { mkAccount, mkRule, mkTransaction } from "./helpers.js";

const NOW = "2026-10-15T12:00:00.000Z";

const USD: CurrencyConverter = (amt) => amt;

const chk = (startingBalance: MinorUnits) =>
  mkAccount({ id: "chk", name: "Checking", type: "Checking", startingBalance, countsAsSpendable: true });
const card = (startingBalance: MinorUnits) =>
  mkAccount({ id: "cc", name: "Credit One", type: "CreditCard", startingBalance, countsAsSpendable: false });
const loan = (startingBalance: MinorUnits) =>
  mkAccount({ id: "loan", name: "Concord", type: "Loan", startingBalance, countsAsSpendable: false });

function availableFor(
  accounts: Account[],
  balances: Record<string, MinorUnits>,
  projectedBills: SafeToSpendInput["projectedBills"] = [],
): MinorUnits {
  return calculateSafeToSpend({
    today: "2026-10-15",
    accounts,
    balances,
    projectedBills,
    scheduledBills: [],
    goalContributions: 0,
    countedIous: 0,
    buffer: 0,
    todaySpending: 0,
    nextPayday: "2026-10-30",
    baseCurrency: "USD",
    convertToBase: USD,
  }).available;
}

/** Settle a Scheduled row in place, like every settle path does. */
function settleInPlace(t: Transaction, amount: MinorUnits): Transaction {
  return { ...t, status: "Cleared", amount, date: "2026-10-15", updatedAt: NOW };
}

describe("debt-payment rules generate Transfers", () => {
  it("generates a Transfer to the debt account with no category", () => {
    const rule = mkRule({
      id: "rule-ccmin",
      name: "Credit One minimum",
      kind: "Bill",
      amount: 4700,
      accountId: "chk",
      isCreditCardPayment: true,
      payToAccountId: "cc",
      frequency: "monthly",
      nextDueDate: "2026-10-15",
    });
    const gen = generateDueTransactions(rule, [], [], "2026-10-15", NOW);
    expect(gen.transactions).toHaveLength(1);
    expect(gen.transactions[0]).toMatchObject({
      type: "Transfer",
      transferToAccountId: "cc",
      categoryId: null,
      accountId: "chk",
      amount: 4700,
      status: "Scheduled",
      recurringRuleId: "rule-ccmin",
    });
  });

  it("generates a Transfer for a loan-payment rule (no isCreditCardPayment flag)", () => {
    const rule = mkRule({
      id: "rule-loanmin",
      name: "Concord minimum",
      kind: "Bill",
      amount: 26400,
      accountId: "chk",
      payToAccountId: "loan",
      frequency: "monthly",
      nextDueDate: "2026-10-15",
    });
    const gen = generateDueTransactions(rule, [], [], "2026-10-15", NOW);
    expect(gen.transactions).toHaveLength(1);
    expect(gen.transactions[0]).toMatchObject({
      type: "Transfer",
      transferToAccountId: "loan",
      categoryId: null,
    });
  });

  it("still generates Expenses for plain bills", () => {
    const rule = mkRule({ kind: "Bill", amount: 6200, nextDueDate: "2026-10-15" });
    const gen = generateDueTransactions(rule, [], [], "2026-10-15", NOW);
    expect(gen.transactions[0]!.type).toBe("Expense");
  });

  it("marks projections as debt payments keyed on payToAccountId", () => {
    const cardRule = mkRule({ id: "r-card", payToAccountId: "cc", nextDueDate: "2026-10-20" });
    const loanRule = mkRule({ id: "r-loan", payToAccountId: "loan", nextDueDate: "2026-10-20" });
    const plain = mkRule({ id: "r-plain", nextDueDate: "2026-10-20" });
    const typeOf = (id: string) =>
      id === "cc" ? ("CreditCard" as const) : id === "loan" ? ("Loan" as const) : undefined;
    const out = projectOccurrences([cardRule, loanRule, plain], [], "2026-10-15", "2026-10-31", typeOf);
    expect(out.find((p) => p.ruleId === "r-card")!.isDebtPayment).toBe(true);
    expect(out.find((p) => p.ruleId === "r-loan")!.isDebtPayment).toBe(true);
    expect(out.find((p) => p.ruleId === "r-plain")!.isDebtPayment).toBe(false);
    // ...but only the card payment is excluded from committed
    expect(out.find((p) => p.ruleId === "r-card")!.isCardPayment).toBe(true);
    expect(out.find((p) => p.ruleId === "r-loan")!.isCardPayment).toBe(false);
    expect(out.find((p) => p.ruleId === "r-plain")!.isCardPayment).toBe(false);
  });

  it("isCardPaymentRule keys the committed exclusion on the destination account type", () => {
    const typeOf = (id: string) =>
      id === "cc" ? ("CreditCard" as const) : id === "loan" ? ("Loan" as const) : undefined;
    // payToAccountId -> CreditCard: excluded
    expect(
      isCardPaymentRule(mkRule({ payToAccountId: "cc" }), typeOf),
    ).toBe(true);
    // payToAccountId -> Loan: stays in committed
    expect(
      isCardPaymentRule(mkRule({ payToAccountId: "loan" }), typeOf),
    ).toBe(false);
    // legacy flag with no payToAccountId: excluded (defensive)
    expect(
      isCardPaymentRule(mkRule({ isCreditCardPayment: true }), typeOf),
    ).toBe(true);
    // plain bill: not a card payment
    expect(isCardPaymentRule(mkRule({}), typeOf)).toBe(false);
    // payToAccountId pointing at a missing account: safe default, stays in committed
    expect(
      isCardPaymentRule(mkRule({ payToAccountId: "gone" }), typeOf),
    ).toBe(false);
  });
});

describe("marking a card minimum paid", () => {
  function setup() {
    const accounts = [chk(100000), card(-50000)];
    const rule = mkRule({
      id: "rule-ccmin",
      name: "Credit One minimum",
      amount: 4700,
      accountId: "chk",
      isCreditCardPayment: true,
      payToAccountId: "cc",
      frequency: "monthly",
      nextDueDate: "2026-10-15",
    });
    const gen = generateDueTransactions(rule, [], [], "2026-10-15", NOW);
    return { accounts, row: gen.transactions[0]! };
  }

  it("reduces the card balance and does not count as an expense", () => {
    const { accounts, row } = setup();
    const settled = settleInPlace(row, 4700);
    const balances = deriveBalances(accounts, [settled]);
    expect(balances).toEqual({ chk: 95300, cc: -45300 });
    // Not an expense: today's spending ignores it.
    const todaySpending = computeTodaySpending([settled], "2026-10-15", (t) => t.amount);
    expect(todaySpending).toBe(0);
  });

  it("leaves safe-to-spend available unchanged", () => {
    const { accounts, row } = setup();
    const before = deriveBalances(accounts, [row]); // Scheduled: no balance effect
    const settled = settleInPlace(row, 4700);
    const after = deriveBalances(accounts, [settled]);
    expect(availableFor(accounts, before)).toBe(50000);
    expect(availableFor(accounts, after)).toBe(50000);
  });

  it("excludes the card-payment projection from committed (no double count)", () => {
    const { accounts } = setup();
    const projected = projectOccurrences(
      [mkRule({ id: "rule-ccmin", payToAccountId: "cc", isCreditCardPayment: true, nextDueDate: "2026-10-20" })],
      [],
      "2026-10-15",
      "2026-10-30",
    );
    const r = calculateSafeToSpend({
      today: "2026-10-15",
      accounts,
      balances: { chk: 100000, cc: -50000 },
      projectedBills: projected,
      scheduledBills: [],
      goalContributions: 0,
      countedIous: 0,
      buffer: 0,
      todaySpending: 0,
      nextPayday: "2026-10-30",
      baseCurrency: "USD",
      convertToBase: USD,
    });
    expect(r.committed).toBe(0);
  });
});

describe("loan payments", () => {
  it("reduces the loan balance when paid, but the unpaid minimum stays in committed", () => {
    const accounts = [chk(200000), loan(-148835)];
    const accountTypeOf = (id: string) => accounts.find((a) => a.id === id)?.type;
    const rule = mkRule({
      id: "rule-loanmin",
      name: "Concord minimum",
      amount: 26400,
      accountId: "chk",
      payToAccountId: "loan",
      frequency: "monthly",
      nextDueDate: "2026-10-15",
    });
    // Paying drops the loan balance: a Transfer, never an expense.
    const gen = generateDueTransactions(rule, [], [], "2026-10-15", NOW);
    const settled = settleInPlace(gen.transactions[0]!, 26400);
    const balances = deriveBalances(accounts, [settled]);
    expect(balances).toEqual({ chk: 173600, loan: -122435 });

    // But the UNPAID minimum is committed: loan balances are not subtracted
    // from available, so excluding it would never set the money aside.
    const projected = projectOccurrences([rule], [], "2026-10-15", "2026-10-30", accountTypeOf);
    const r = calculateSafeToSpend({
      today: "2026-10-15",
      accounts,
      balances: { chk: 200000, loan: -148835 },
      projectedBills: projected,
      scheduledBills: [],
      goalContributions: 0,
      countedIous: 0,
      buffer: 0,
      todaySpending: 0,
      nextPayday: "2026-10-30",
      baseCurrency: "USD",
      convertToBase: USD,
    });
    expect(r.committed).toBe(26400);
  });

  it("an overdue loan payment reduces safe-to-spend", () => {
    const accounts = [chk(200000), loan(-148835)];
    // Overdue bills count via their Scheduled rows (catch-up guarantees
    // those exist): a loan Transfer row must survive committed.
    const overdueRow = mkTransaction({
      id: "tx-overdue-loan",
      type: "Transfer",
      status: "Scheduled",
      amount: 26400,
      accountId: "chk",
      transferToAccountId: "loan",
      categoryId: null,
      payee: "Concord minimum",
      date: "2026-10-10",
      occurrenceDate: "2026-10-10",
      recurringRuleId: "rule-loanmin",
    });
    const input = {
      today: "2026-10-15" as const,
      accounts,
      balances: { chk: 200000, loan: -148835 },
      projectedBills: [],
      goalContributions: 0,
      countedIous: 0,
      buffer: 0,
      todaySpending: 0,
      nextPayday: "2026-10-30" as const,
      baseCurrency: "USD",
      convertToBase: USD,
    };
    const withBill = calculateSafeToSpend({ ...input, scheduledBills: [overdueRow] });
    const withoutBill = calculateSafeToSpend({ ...input, scheduledBills: [] });
    expect(withBill.committed).toBe(26400);
    // The safe-to-spend daily number drops: the $264 minimum is set aside
    // ($1736.00 / 15 days, floored to the whole dollar).
    expect(withBill.dailyAmount).toBe(11500);
    expect(withBill.dailyAmount).toBeLessThan(withoutBill.dailyAmount);
  });
});

describe("settleCardPayment (Payday Run card step)", () => {
  const CYCLE = { cycleStart: "2026-10-15" as const, cycleEnd: "2026-10-29" as const };

  function scheduledRow(o: Partial<Transaction> = {}): Transaction {
    return mkTransaction({
      type: "Transfer",
      amount: 4700,
      status: "Scheduled",
      accountId: "chk",
      categoryId: null,
      transferToAccountId: "cc",
      recurringRuleId: "rule-ccmin",
      occurrenceDate: "2026-10-20",
      date: "2026-10-20",
      payee: "Credit One minimum",
      ...o,
    });
  }

  const rule = mkRule({
    id: "rule-ccmin",
    name: "Credit One minimum",
    isCreditCardPayment: true,
    payToAccountId: "cc",
  });

  const input = {
    cardId: "cc",
    sourceAccountId: "chk",
    sourceCurrency: "USD",
    cardName: "Credit One",
    amount: 5000,
    today: "2026-10-16" as const,
    ...CYCLE,
    nowIso: NOW,
  };

  it("rejects a source account equal to the card being paid", () => {
    expect(() =>
      settleCardPayment([scheduledRow()], [rule], { ...input, sourceAccountId: "cc" }),
    ).toThrow("Pick a different account than the one being paid.");
  });

  it("settles the open Scheduled row in place, no second transfer", () => {
    const row = scheduledRow();
    const res = settleCardPayment([row], [rule], input);
    expect(res.settledScheduled).toBe(true);
    expect(res.transactionId).toBe(row.id);
    expect(res.transactions).toHaveLength(1);
    expect(res.transactions[0]).toMatchObject({
      id: row.id,
      type: "Transfer",
      transferToAccountId: "cc",
      status: "Cleared",
      amount: 5000,
      date: "2026-10-16",
      recurringRuleId: "rule-ccmin",
      occurrenceDate: "2026-10-20",
    });
  });

  it("creates a new Transfer when no scheduled row exists", () => {
    const res = settleCardPayment([], [rule], input);
    expect(res.settledScheduled).toBe(false);
    expect(res.transactions).toHaveLength(1);
    expect(res.transactionId).not.toBe("");
    expect(res.transactions[0]).toMatchObject({
      id: res.transactionId,
      type: "Transfer",
      transferToAccountId: "cc",
      categoryId: null,
      status: "Cleared",
      amount: 5000,
      date: "2026-10-16",
      accountId: "chk",
    });
  });

  it("ignores rows for other cards, outside the cycle, or already settled", () => {
    const otherCard = scheduledRow({ recurringRuleId: "rule-other" });
    const otherRule = mkRule({ id: "rule-other", payToAccountId: "other-card" });
    const outOfCycle = scheduledRow({ occurrenceDate: "2026-10-30", date: "2026-10-30" });
    const settled = scheduledRow({ status: "Cleared" });
    const res = settleCardPayment([otherCard, outOfCycle, settled], [rule, otherRule], input);
    expect(res.settledScheduled).toBe(false);
    expect(res.transactions).toHaveLength(4); // nothing settled in place
  });
});

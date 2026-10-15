import { describe, expect, it } from "vitest";
import { deriveBalances } from "../src/domain/engine/balances.js";
import {
  completePaydayRun,
  confirmPaydayIncome,
  createPaydayRunState,
} from "../src/domain/engine/paydayRun.js";
import { generateDueTransactions } from "../src/domain/engine/recurringEngine.js";
import { mkAccount, mkRule, mkTransaction } from "./helpers.js";

const NOW = "2026-10-15T12:00:00.000Z";

describe("payday confirmation", () => {
  function generatedPayday() {
    const rule = mkRule({
      id: "pay-rule",
      kind: "Income",
      name: "Paycheck",
      amount: 226341,
      frequency: "semi-monthly",
      daysOfMonth: [15, 30],
      nextDueDate: "2026-10-15",
    });
    const res = generateDueTransactions(rule, [], [], "2026-10-15", NOW);
    expect(res.transactions).toHaveLength(1);
    expect(res.transactions[0]!.status).toBe("Scheduled");
    return { rule, txs: res.transactions };
  }

  it("flips the Scheduled row to Cleared in place, no second income row", () => {
    const { rule, txs } = generatedPayday();
    const { transactions, confirmed } = confirmPaydayIncome(txs, rule.id, "2026-10-15", 226341, "Cleared", NOW);
    expect(confirmed).toBe(true);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({ status: "Cleared", amount: 226341, id: txs[0]!.id });
  });

  it("supports confirming a different amount (overtime) and Pending status", () => {
    const { rule, txs } = generatedPayday();
    const { transactions } = confirmPaydayIncome(txs, rule.id, "2026-10-15", 230000, "Pending", NOW);
    expect(transactions[0]).toMatchObject({ status: "Pending", amount: 230000 });
  });

  it("does not match the wrong occurrence or a non-Scheduled row", () => {
    const { rule, txs } = generatedPayday();
    const wrongDate = confirmPaydayIncome(txs, rule.id, "2026-10-30", 226341, "Cleared", NOW);
    expect(wrongDate.confirmed).toBe(false);
    expect(wrongDate.transactions).toHaveLength(1);
  });

  it("unconfirmed payday income contributes nothing to available", () => {
    const { txs } = generatedPayday();
    const acct = mkAccount({ id: "chk", startingBalance: 0 });
    const balances = deriveBalances([acct], txs);
    expect(balances).toEqual({ chk: 0 }); // Scheduled income excluded
  });

  it("confirmed payday income lands in available exactly once", () => {
    const rule = mkRule({
      id: "pay-rule",
      kind: "Income",
      name: "Paycheck",
      amount: 226341,
      accountId: "chk",
      frequency: "semi-monthly",
      daysOfMonth: [15, 30],
      nextDueDate: "2026-10-15",
    });
    const { transactions } = generateDueTransactions(rule, [], [], "2026-10-15", NOW);
    const confirmed = confirmPaydayIncome(transactions, rule.id, "2026-10-15", 226341, "Cleared", NOW);
    expect(confirmed.transactions).toHaveLength(1);
    const acct = mkAccount({ id: "chk", startingBalance: 0 });
    expect(deriveBalances([acct], confirmed.transactions)).toEqual({ chk: 226341 });
  });
});

describe("payday run state", () => {
  it("creates and completes a run", () => {
    const run = createPaydayRunState("2026-10-15", 226341, NOW);
    expect(run.completed).toBe(false);
    expect(run.steps).toEqual({
      billsSetAside: false,
      goalContributions: {},
      goalsStepDone: false,
      cardPaymentDone: false,
    });
    const done = completePaydayRun(run, NOW);
    expect(done.completed).toBe(true);
  });

  it("generated payday transactions carry income type", () => {
    const rule = mkRule({ kind: "Income", name: "Paycheck", nextDueDate: "2026-10-15" });
    const res = generateDueTransactions(rule, [], [], "2026-10-15", NOW);
    expect(res.transactions[0]!.type).toBe("Income");
    expect(
      mkTransaction({ type: "Income", status: "Scheduled", recurringRuleId: rule.id }).type,
    ).toBe("Income");
  });
});

import { describe, expect, it } from "vitest";
import { deriveBalances, netWorth } from "../src/domain/engine/balances.js";
import { mkAccount, mkTransaction } from "./helpers.js";
describe("deriveBalances", () => {
  it("sums starting balance plus Cleared and Pending only", () => {
    const acct = mkAccount({ id: "a1", startingBalance: 10000 });
    const txs = [
      mkTransaction({ accountId: "a1", type: "Expense", amount: 2500, status: "Cleared" }),
      mkTransaction({ accountId: "a1", type: "Expense", amount: 1000, status: "Pending" }),
      mkTransaction({ accountId: "a1", type: "Expense", amount: 5000, status: "Scheduled" }),
      mkTransaction({ accountId: "a1", type: "Income", amount: 3000, status: "Cleared" }),
    ];
    // 10000 - 2500 - 1000 + 3000 = 9500 (Scheduled excluded)
    expect(deriveBalances([acct], txs)).toEqual({ a1: 9500 });
  });

  it("treats refunds as money back, not income", () => {
    const acct = mkAccount({ id: "a1", startingBalance: 10000 });
    const txs = [mkTransaction({ accountId: "a1", type: "Refund", amount: 800, status: "Cleared" })];
    expect(deriveBalances([acct], txs)).toEqual({ a1: 10800 });
  });

  it("handles transfers between accounts, never as income/expense", () => {
    const checking = mkAccount({ id: "chk", startingBalance: 10000 });
    const savings = mkAccount({ id: "sav", startingBalance: 0, countsAsSpendable: false });
    const txs = [
      mkTransaction({
        accountId: "chk",
        type: "Transfer",
        amount: 4000,
        transferToAccountId: "sav",
        status: "Cleared",
      }),
    ];
    expect(deriveBalances([checking, savings], txs)).toEqual({ chk: 6000, sav: 4000 });
  });

  it("treats self-transfers as balance-neutral", () => {
    const acct = mkAccount({ id: "a1", startingBalance: 10000 });
    const txs = [
      mkTransaction({
        accountId: "a1",
        type: "Transfer",
        amount: 57000,
        transferToAccountId: "a1",
        status: "Cleared",
        goalId: "g1",
      }),
    ];
    expect(deriveBalances([acct], txs)).toEqual({ a1: 10000 });
  });

  it("keeps credit-card balances negative (owed)", () => {
    const card = mkAccount({ id: "cc", type: "CreditCard", startingBalance: 0, countsAsSpendable: false });
    const txs = [
      mkTransaction({ accountId: "cc", type: "Expense", amount: 93492, status: "Cleared" }),
      mkTransaction({ accountId: "cc", type: "Expense", amount: 5000, status: "Pending" }),
    ];
    // spending on the card increases what is owed, immediately
    expect(deriveBalances([card], txs)).toEqual({ cc: -(93492 + 5000) });
  });

  it("a card payment is a transfer that reduces what is owed", () => {
    const card = mkAccount({ id: "cc", type: "CreditCard", startingBalance: -93492, countsAsSpendable: false });
    const chk = mkAccount({ id: "chk", startingBalance: 100000 });
    const txs = [
      mkTransaction({
        accountId: "chk",
        type: "Transfer",
        amount: 4700,
        transferToAccountId: "cc",
        status: "Cleared",
      }),
    ];
    expect(deriveBalances([chk, card], txs)).toEqual({ chk: 95300, cc: -88792 });
  });

  it("uses the frozen FX baseAmount when present", () => {
    const acct = mkAccount({ id: "a1", startingBalance: 0 });
    const txs = [
      mkTransaction({
        accountId: "a1",
        type: "Expense",
        amount: 1000,
        currency: "EUR",
        status: "Cleared",
        fx: { originalAmount: 1000, originalCurrency: "EUR", rate: 1.08, baseAmount: 1080 },
      }),
    ];
    expect(deriveBalances([acct], txs)).toEqual({ a1: -1080 });
  });

  it("ignores transactions for unknown accounts", () => {
    const acct = mkAccount({ id: "a1", startingBalance: 500 });
    const txs = [mkTransaction({ accountId: "nope", type: "Expense", amount: 100, status: "Cleared" })];
    expect(deriveBalances([acct], txs)).toEqual({ a1: 500 });
  });
});

describe("netWorth", () => {
  it("nets assets against card debt", () => {
    expect(netWorth({ a: 100000, cc: -93492 })).toBe(6508);
    expect(netWorth({})).toBe(0);
  });
});

describe("multi-currency balances stay per-account", () => {
  it("does not convert inside deriveBalances", () => {
    const usd = mkAccount({ id: "u", currency: "USD", startingBalance: 10000 });
    const jpy = mkAccount({ id: "j", currency: "JPY", startingBalance: 5000 });
    const txs = [mkTransaction({ accountId: "j", type: "Expense", amount: 1000, currency: "JPY", status: "Cleared" })];
    const b = deriveBalances([usd, jpy], txs);
    expect(b).toEqual({ u: 10000, j: 4000 }); // raw per-account units; conversion happens at sum time
  });
});

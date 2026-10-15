import { describe, expect, it } from "vitest";
import {
  defaultCountsAsSpendable,
  isLiabilityAccount,
  toStoredBalance,
} from "../src/domain/entities/account.js";
import { mkAccount } from "./helpers.js";

describe("toStoredBalance", () => {
  it("stores a credit-card amount owed (entered positive) as negative", () => {
    expect(toStoredBalance("CreditCard", 93492)).toBe(-93492);
  });

  it("stores a loan amount owed (entered positive) as negative", () => {
    expect(toStoredBalance("Loan", 148835)).toBe(-148835);
  });

  it("keeps an already-negative liability entry negative", () => {
    expect(toStoredBalance("CreditCard", -5000)).toBe(-5000);
    expect(toStoredBalance("Loan", -5000)).toBe(-5000);
  });

  it("stores other account types as entered", () => {
    expect(toStoredBalance("Checking", 25000)).toBe(25000);
    expect(toStoredBalance("Savings", 0)).toBe(0);
  });

  it("rejects non-integer input", () => {
    expect(() => toStoredBalance("CreditCard", 10.5)).toThrow(TypeError);
  });
});

describe("loan account type", () => {
  it("is a liability, like credit cards", () => {
    expect(isLiabilityAccount(mkAccount({ type: "Loan" }))).toBe(true);
    expect(isLiabilityAccount(mkAccount({ type: "CreditCard" }))).toBe(true);
    expect(isLiabilityAccount(mkAccount({ type: "Checking" }))).toBe(false);
  });

  it("is not spendable by default", () => {
    expect(defaultCountsAsSpendable("Loan")).toBe(false);
    expect(defaultCountsAsSpendable("CreditCard")).toBe(false);
    expect(defaultCountsAsSpendable("Savings")).toBe(false);
    expect(defaultCountsAsSpendable("Checking")).toBe(true);
    expect(defaultCountsAsSpendable("Cash")).toBe(true);
  });
});

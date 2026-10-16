/** Categorization tests (Phase B). */
import { describe, expect, it } from "vitest";
import { buildMerchantHistory, categorize } from "../src/domain/import/categorize.js";
import { mkCategory } from "./helpers.js";
import type { MerchantRule } from "../src/domain/entities/merchantRule.js";

const CATS = [
  mkCategory({ id: "cat-food", name: "Food", kind: "expense" }),
  mkCategory({ id: "cat-transit", name: "Transit", kind: "expense" }),
  mkCategory({ id: "cat-ent", name: "Entertainment", kind: "expense" }),
  mkCategory({ id: "cat-other", name: "Other", kind: "expense" }),
  mkCategory({ id: "cat-income", name: "Income", kind: "income" }),
];

const base = {
  categories: CATS,
  learnedRules: [] as MerchantRule[],
  history: new Map(),
};

describe("categorize", () => {
  it("prefers learned rules over everything", () => {
    const learned: MerchantRule[] = [
      { id: "r1", merchantKey: "CITI BIKE", categoryId: "cat-transit", payeeName: "Citi Bike", createdAt: "x", updatedAt: "x" },
    ];
    const res = categorize({
      ...base,
      learnedRules: learned,
      rawDescription: "PURCHASE AUTHORIZED ON 10/13 CITI BIKE*TRIP",
      isOutflow: true,
    });
    expect(res).toMatchObject({
      categoryId: "cat-transit",
      payee: "Citi Bike",
      confidence: "high",
      via: "learned",
    });
  });

  it("uses history when the merchant is familiar", () => {
    const history = buildMerchantHistory([
      { payee: "Citi Bike", categoryId: "cat-transit" },
      { payee: "Citi Bike", categoryId: "cat-transit" },
      { payee: "Citi Bike", categoryId: "cat-transit" },
    ]);
    const res = categorize({
      ...base,
      history,
      rawDescription: "PURCHASE AUTHORIZED ON 10/13 CITI BIKE*TRIP",
      isOutflow: true,
    });
    expect(res).toMatchObject({ categoryId: "cat-transit", confidence: "high", via: "history" });
  });

  it("treats thin history as a low-confidence hint", () => {
    const history = buildMerchantHistory([{ payee: "Citi Bike", categoryId: "cat-transit" }]);
    const res = categorize({
      ...base,
      history,
      rawDescription: "PURCHASE AUTHORIZED ON 10/13 CITI BIKE*TRIP",
      isOutflow: true,
    });
    expect(res).toMatchObject({ confidence: "low", via: "history" });
  });

  it("falls back to built-in patterns at low confidence", () => {
    const res = categorize({
      ...base,
      rawDescription: "RECURRING PAYMENT AUTHORIZED ON 10/01 SPOTIFY USA",
      isOutflow: true,
    });
    expect(res).toMatchObject({ categoryId: "cat-ent", confidence: "low", via: "builtin" });
  });

  it("admits defeat on the unknown", () => {
    const res = categorize({
      ...base,
      rawDescription: "SOME WEIRD CHARGE 92847 XYZ",
      isOutflow: true,
    });
    expect(res).toMatchObject({ categoryId: null, confidence: "low", via: "default" });
  });

  it("types refunds with the original category, never as income", () => {
    const history = buildMerchantHistory([
      { payee: "Amazon", categoryId: "cat-other" },
      { payee: "Amazon", categoryId: "cat-other" },
    ]);
    const res = categorize({
      ...base,
      history,
      rawDescription: "AMAZON REFUND 10/14",
      isOutflow: false,
    });
    expect(res).toMatchObject({ isRefund: true, categoryId: "cat-other", confidence: "high" });
  });

  it("flags refunds with no known category for review", () => {
    const res = categorize({ ...base, rawDescription: "AMAZON REFUND 10/14", isOutflow: false });
    expect(res).toMatchObject({ isRefund: true, categoryId: null, confidence: "low" });
  });

  it("types fees as expenses, never transfers", () => {
    const res = categorize({ ...base, rawDescription: "INTEREST CHARGE ON PURCHASES", isOutflow: true });
    expect(res).toMatchObject({ via: "fee", confidence: "high", isRefund: false });
    expect(res.categoryId).toBe("cat-other");
  });
});

/** Payee cleaning tests (Phase B). */
import { describe, expect, it } from "vitest";
import {
  cleanPayee,
  looksLikeFeeOrInterest,
  looksLikeRefund,
  merchantKey,
} from "../src/domain/import/payeeClean.js";

describe("cleanPayee", () => {
  it("turns a messy card line into a readable payee", () => {
    expect(
      cleanPayee("PURCHASE AUTHORIZED ON 10/13 CITI BIKE*TRIP NEW YORK NY S5802871234567890 CARD 1234"),
    ).toBe("Citi Bike");
  });

  it("cleans recurring authorizations", () => {
    expect(cleanPayee("RECURRING PAYMENT AUTHORIZED ON 10/01 SPOTIFY USA 877-778-1161")).toBe("Spotify");
  });

  it("cleans direct deposits", () => {
    expect(cleanPayee("DIRECT DEP ROC NATION LLC PAYROLL")).toBe("Roc Nation");
    expect(cleanPayee("DIRECT DEPOSIT ROC NATION LLC PAYROLL")).toBe("Roc Nation");
  });

  it("keeps Zelle phrases readable", () => {
    expect(cleanPayee("ZELLE TO MALIKE SIDIBE ON 10/16/2026 REF # 9876543210")).toBe(
      "Zelle To Malike Sidibe",
    );
  });

  it("keeps online transfer phrases readable", () => {
    expect(cleanPayee("ONLINE TRANSFER TO SIDIBE M WAY2SAVE SAVINGS")).toBe(
      "Online Transfer To Sidibe M Way2save Savings",
    );
  });
});

describe("merchantKey", () => {
  it("keys variants alike", () => {
    expect(merchantKey("Citi Bike")).toBe(merchantKey("CITI BIKE"));
    expect(merchantKey("Roc Nation")).toBe("ROC NATION");
  });
});

describe("looksLikeRefund / looksLikeFeeOrInterest", () => {
  it("spots refunds", () => {
    expect(looksLikeRefund("AMAZON REFUND 10/14")).toBe(true);
    expect(looksLikeRefund("PURCHASE AUTHORIZED ON 10/13 CITI BIKE")).toBe(false);
  });

  it("spots fees and interest", () => {
    expect(looksLikeFeeOrInterest("INTEREST CHARGE ON PURCHASES")).toBe(true);
    expect(looksLikeFeeOrInterest("ANNUAL FEE")).toBe(true);
    expect(looksLikeFeeOrInterest("PURCHASE AUTHORIZED ON 10/13 CITI BIKE")).toBe(false);
  });
});

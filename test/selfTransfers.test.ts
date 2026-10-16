/** Self-transfer signal detection tests (Phase B). */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SELF_NAME_VARIATIONS,
  detectTransferSignal,
  isSelfCounterparty,
  otherAccountLabel,
} from "../src/domain/import/selfTransfers.js";

describe("detectTransferSignal", () => {
  it("parses Way2Save online transfers both ways", () => {
    expect(detectTransferSignal("ONLINE TRANSFER FROM SIDIBE M WAY2SAVE SAVINGS")).toEqual({
      kind: "online-transfer",
      direction: "FROM",
      counterparty: "SIDIBE M WAY2SAVE SAVINGS",
    });
    expect(detectTransferSignal("ONLINE TRANSFER TO SIDIBE M WAY2SAVE SAVINGS")).toMatchObject({
      kind: "online-transfer",
      direction: "TO",
    });
  });

  it("parses Zelle lines", () => {
    expect(detectTransferSignal("ZELLE FROM MALIKE SIDIBE ON 10/15/2026 REF # 123456")).toEqual({
      kind: "zelle",
      direction: "FROM",
      counterparty: "MALIKE SIDIBE",
    });
    expect(detectTransferSignal("ZELLE TO MALIKE SIDIBE ON 10/16/2026 REF # 789")).toMatchObject({
      kind: "zelle",
      direction: "TO",
    });
  });

  it("ignores ordinary purchases", () => {
    expect(detectTransferSignal("PURCHASE AUTHORIZED ON 10/13 CITI BIKE")).toBeNull();
    expect(detectTransferSignal("ZELLE TO JANE DOE ON 10/16/2026 REF # 1")).not.toBeNull();
  });
});

describe("isSelfCounterparty", () => {
  it("matches the bank's two name spellings", () => {
    expect(isSelfCounterparty("SIDIBE M WAY2SAVE SAVINGS", DEFAULT_SELF_NAME_VARIATIONS)).toBe(true);
    expect(isSelfCounterparty("MALIKE SIDIBE", DEFAULT_SELF_NAME_VARIATIONS)).toBe(true);
    expect(isSelfCounterparty("JANE DOE", DEFAULT_SELF_NAME_VARIATIONS)).toBe(false);
  });

  it("honours extra variations", () => {
    expect(isSelfCounterparty("M SIDIBE", [...DEFAULT_SELF_NAME_VARIATIONS, "M SIDIBE"])).toBe(true);
  });

  it("does not prefix-match strangers", () => {
    expect(isSelfCounterparty("SIDIBE MART", DEFAULT_SELF_NAME_VARIATIONS)).toBe(false);
  });
});

describe("otherAccountLabel", () => {
  it("extracts the Way2Save label", () => {
    const signal = detectTransferSignal("ONLINE TRANSFER FROM SIDIBE M WAY2SAVE SAVINGS");
    expect(signal && otherAccountLabel(signal, DEFAULT_SELF_NAME_VARIATIONS)).toBe("WAY2SAVE SAVINGS");
  });

  it("returns null for Zelle (no account named)", () => {
    const signal = detectTransferSignal("ZELLE FROM MALIKE SIDIBE ON 10/15/2026 REF # 1");
    expect(signal && otherAccountLabel(signal, DEFAULT_SELF_NAME_VARIATIONS)).toBeNull();
  });
});

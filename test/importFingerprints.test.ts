/** Fingerprint + count-based dedup tests (Phase A). */
import { describe, expect, it } from "vitest";
import {
  bankRowFingerprint,
  collapseCrossFileDuplicates,
  normalizeDescription,
  planDedup,
} from "../src/domain/import/fingerprints.js";

describe("normalizeDescription", () => {
  it("strips Zelle dates and Ref #s so re-posts fingerprint alike", () => {
    expect(normalizeDescription("ZELLE TO MALIKE SIDIBE ON 10/16/2026 REF # 9876543210")).toBe(
      "ZELLE TO MALIKE SIDIBE",
    );
    expect(normalizeDescription("ZELLE TO MALIKE SIDIBE ON 10/17/2026 REF # 1111111111")).toBe(
      "ZELLE TO MALIKE SIDIBE",
    );
  });

  it("upper-cases and collapses messy bank text", () => {
    // Partial auth dates ("ON 10/13", no year) are kept: stripping them
    // could merge distinct same-day purchases. Full dates with a year
    // (Zelle's "ON 10/16/2026") are stripped above.
    expect(
      normalizeDescription("PURCHASE AUTHORIZED ON 10/13 CITI BIKE*TRIP NEW YORK NY S5802871234567890 CARD 1234"),
    ).toBe("PURCHASE AUTHORIZED ON 10 13 CITI BIKE TRIP NEW YORK NY S5802871234567890 CARD 1234");
  });
});

describe("bankRowFingerprint", () => {
  const base = {
    accountId: "acct-checking",
    date: "2026-10-16" as const,
    amountMinor: -876 as const,
    description: "PURCHASE AUTHORIZED ON 10/13 CITI BIKE",
  };

  it("is deterministic", () => {
    expect(bankRowFingerprint(base)).toBe(bankRowFingerprint({ ...base }));
  });

  it("distinguishes account, date, amount, and description", () => {
    const a = bankRowFingerprint(base);
    expect(bankRowFingerprint({ ...base, accountId: "other" })).not.toBe(a);
    expect(bankRowFingerprint({ ...base, date: "2026-10-17" as const })).not.toBe(a);
    expect(bankRowFingerprint({ ...base, amountMinor: 876 as const })).not.toBe(a);
    expect(bankRowFingerprint({ ...base, description: "COFFEE" })).not.toBe(a);
  });

  it("prefers the stable id when present", () => {
    const fp = bankRowFingerprint({ ...base, stableId: "zelle:9876543210" });
    expect(fp).toBe("zelle:9876543210");
    // Same ref on a different date/amount still matches (re-post case).
    expect(
      bankRowFingerprint({ ...base, date: "2026-10-17" as const, stableId: "zelle:9876543210" }),
    ).toBe(fp);
  });
});

describe("planDedup", () => {
  const fp = (s: string) => s;

  it("imports everything when nothing was seen", () => {
    const { keep, skipped } = planDedup(["a", "b"], fp, () => 0);
    expect(keep).toEqual(["a", "b"]);
    expect(skipped).toEqual([]);
  });

  it("compares counts: file has 2, ledger has 1 -> import 1", () => {
    const { keep, skipped } = planDedup(["x", "x"], fp, () => 1);
    expect(keep).toEqual(["x"]);
    expect(skipped).toEqual(["x"]);
  });

  it("re-importing the same file creates zero new rows", () => {
    const { keep, skipped } = planDedup(["x", "y", "z"], fp, () => 1);
    expect(keep).toEqual([]);
    expect(skipped).toEqual(["x", "y", "z"]);
  });

  it("two identical same-day rows are both imported when neither was seen", () => {
    const { keep, skipped } = planDedup(["x", "x"], fp, () => 0);
    expect(keep).toEqual(["x", "x"]);
    expect(skipped).toEqual([]);
  });
});

describe("collapseCrossFileDuplicates", () => {
  const item = (fp: string, file: string) => ({ fp, file });
  const fpOf = (i: { fp: string }) => i.fp;
  const fileOf = (i: { file: string }) => i.file;

  it("drops the second file's copy of an overlapping row", () => {
    const a = item("x", "2024.csv");
    const b = item("x", "2025.csv");
    const dropped = collapseCrossFileDuplicates([a, b], fpOf, fileOf);
    expect([...dropped]).toEqual([b]);
  });

  it("keeps identical rows within one file (both can be real)", () => {
    const a = item("x", "2024.csv");
    const b = item("x", "2024.csv");
    expect(collapseCrossFileDuplicates([a, b], fpOf, fileOf).size).toBe(0);
  });
});

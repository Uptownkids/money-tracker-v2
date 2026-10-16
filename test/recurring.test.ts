/**
 * Recurring-charge detection tests (Phase B2).
 */
import { describe, expect, it } from "vitest";
import {
  detectRecurring,
  nextExpectedDate,
  type RecurringCharge,
} from "../src/domain/import/recurring.js";

function charge(date: string, amount: number, merchantKey = "SPOTIFY", id?: string): RecurringCharge {
  return {
    transactionId: id ?? `tx-${date}`,
    date: date as never,
    amount,
    merchantKey,
    payee: "Spotify",
    categoryId: "cat-music",
    accountId: "acct-checking",
  };
}

describe("detectRecurring", () => {
  it("auto-detects a monthly subscription", () => {
    const out = detectRecurring([
      charge("2026-07-15", 1299),
      charge("2026-08-15", 1299),
      charge("2026-09-15", 1299),
      charge("2026-10-15", 1299),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      cadence: "monthly",
      strength: "auto",
      avgAmount: 1299,
      amountVaries: false,
      since: "2026-07-15",
    });
  });

  it("auto-detects a yearly subscription", () => {
    const out = detectRecurring([
      charge("2024-10-01", 9999),
      charge("2025-10-01", 9999),
      charge("2026-10-01", 9999),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ cadence: "yearly", strength: "auto" });
  });

  it("auto-detects a weekly charge", () => {
    const out = detectRecurring([
      charge("2026-10-01", 3500, "CLEANER"),
      charge("2026-10-08", 3500, "CLEANER"),
      charge("2026-10-15", 3500, "CLEANER"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ cadence: "weekly", strength: "auto" });
  });

  it("auto-detects varying-amount bills on a consistent schedule", () => {
    const out = detectRecurring([
      charge("2026-07-10", 6020, "CONED"),
      charge("2026-08-10", 9544, "CONED"),
      charge("2026-09-10", 7210, "CONED"),
      charge("2026-10-10", 11032, "CONED"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      cadence: "monthly",
      strength: "auto",
      amountVaries: true,
    });
    // Recent average of the last 3.
    expect(out[0]?.avgAmount).toBe(Math.round((9544 + 7210 + 11032) / 3));
  });

  it("suggests (not auto) a two-charge pattern", () => {
    const out = detectRecurring([charge("2026-09-15", 1299), charge("2026-10-15", 1299)]);
    expect(out).toHaveLength(1);
    expect(out[0]?.strength).toBe("suggest");
  });

  it("ignores irregular charges", () => {
    const out = detectRecurring([
      charge("2026-07-01", 5000, "RANDOM"),
      charge("2026-07-20", 5000, "RANDOM"),
      charge("2026-10-15", 5000, "RANDOM"),
    ]);
    expect(out).toHaveLength(0);
  });

  it("suggests a mostly-consistent pattern with one wobble", () => {
    const out = detectRecurring([
      charge("2026-06-15", 1299),
      charge("2026-07-15", 1299),
      charge("2026-09-01", 1299), // ~48 days: a wobble
      charge("2026-10-01", 1299),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.strength).toBe("suggest");
  });

  it("requires at least 3 charges for auto", () => {
    const out = detectRecurring([charge("2026-08-15", 1299), charge("2026-09-15", 1299), charge("2026-10-15", 1299)]);
    expect(out[0]?.strength).toBe("auto");
  });

  it("picks the most common account and category", () => {
    const a = charge("2026-08-15", 1299);
    const b = { ...charge("2026-09-15", 1299), accountId: "acct-other" };
    const c = { ...charge("2026-10-15", 1299), accountId: "acct-other" };
    const out = detectRecurring([a, b, c]);
    expect(out[0]?.accountId).toBe("acct-other");
  });
});

describe("nextExpectedDate", () => {
  it("adds a week, a month, a year", () => {
    expect(nextExpectedDate("2026-10-15" as never, "weekly")).toBe("2026-10-22");
    expect(nextExpectedDate("2026-10-15" as never, "monthly")).toBe("2026-11-15");
    expect(nextExpectedDate("2026-10-15" as never, "yearly")).toBe("2027-10-15");
  });

  it("clamps month-end", () => {
    expect(nextExpectedDate("2026-01-31" as never, "monthly")).toBe("2026-02-28");
  });
});

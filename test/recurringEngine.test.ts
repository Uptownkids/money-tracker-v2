import { describe, expect, it } from "vitest";
import {
  enumerateOccurrences,
  generateDueTransactions,
  generatedStatus,
} from "../src/domain/engine/recurringEngine.js";
import { projectOccurrences } from "../src/domain/engine/projection.js";
import { mkOverride, mkRule, mkTransaction } from "./helpers.js";
import type { DateOnly } from "../src/domain/dates/dateOnly.js";

const NOW = "2026-10-15T12:00:00.000Z";

describe("occurrence enumeration", () => {
  it("never enumerates before a future nextDueDate (no phantom occurrences)", () => {
    // Malike's Google Workspace case, Oct 15 2026: monthly on the 15th,
    // next due Nov 15 because October's charge is already paid. Projecting
    // from Oct 15 must not fabricate an Oct 15 occurrence.
    const rule = mkRule({ frequency: "monthly", nextDueDate: "2026-11-15" });
    expect(
      enumerateOccurrences(rule, [], "2026-10-15", "2026-10-30").map((o) => o.occurrenceDate),
    ).toEqual([]);
  });

  it("resumes a monthly schedule at a future nextDueDate", () => {
    const rule = mkRule({ frequency: "monthly", nextDueDate: "2026-11-15" });
    expect(
      enumerateOccurrences(rule, [], "2026-10-15", "2026-12-20").map((o) => o.occurrenceDate),
    ).toEqual(["2026-11-15", "2026-12-15"]);
  });

  it("clamps semi-monthly enumeration up to a future nextDueDate", () => {
    const rule = mkRule({ frequency: "semi-monthly", daysOfMonth: [15, 30], nextDueDate: "2026-10-30" });
    expect(
      enumerateOccurrences(rule, [], "2026-10-15", "2026-11-16").map((o) => o.occurrenceDate),
    ).toEqual(["2026-10-30", "2026-11-15"]);
  });

  it("generateDueTransactions emits nothing before a future nextDueDate", () => {
    const rule = mkRule({ kind: "Subscription", frequency: "monthly", nextDueDate: "2026-11-15" });
    const res = generateDueTransactions(rule, [], [], "2026-10-15", NOW);
    expect(res.transactions).toHaveLength(0);
  });

  it("handles all frequencies", () => {
    const weekly = mkRule({ frequency: "weekly", nextDueDate: "2026-10-15" });
    expect(enumerateOccurrences(weekly, [], "2026-10-15", "2026-10-29").map((o) => o.occurrenceDate))
      .toEqual(["2026-10-15", "2026-10-22", "2026-10-29"]);

    const biweekly = mkRule({ frequency: "biweekly", nextDueDate: "2026-10-15" });
    expect(enumerateOccurrences(biweekly, [], "2026-10-15", "2026-10-29").map((o) => o.occurrenceDate))
      .toEqual(["2026-10-15", "2026-10-29"]);

    const monthly = mkRule({ frequency: "monthly", nextDueDate: "2026-10-15" });
    expect(enumerateOccurrences(monthly, [], "2026-10-15", "2027-01-20").map((o) => o.occurrenceDate))
      .toEqual(["2026-10-15", "2026-11-15", "2026-12-15", "2027-01-15"]);

    const semi = mkRule({ frequency: "semi-monthly", daysOfMonth: [15, 30], nextDueDate: "2026-10-15" });
    expect(enumerateOccurrences(semi, [], "2026-10-01", "2026-11-30").map((o) => o.occurrenceDate))
      .toEqual(["2026-10-15", "2026-10-30", "2026-11-15", "2026-11-30"]);

    const annual = mkRule({ frequency: "annual", nextDueDate: "2026-03-10" });
    expect(enumerateOccurrences(annual, [], "2026-01-01", "2028-12-31").map((o) => o.occurrenceDate))
      .toEqual(["2026-03-10", "2027-03-10", "2028-03-10"]);

    const custom = mkRule({ frequency: "custom", customIntervalDays: 10, nextDueDate: "2026-10-15" });
    expect(enumerateOccurrences(custom, [], "2026-10-15", "2026-11-05").map((o) => o.occurrenceDate))
      .toEqual(["2026-10-15", "2026-10-25", "2026-11-04"]);
  });

  it("clamps month-end dates (31st -> last day)", () => {
    const rule = mkRule({ frequency: "monthly", nextDueDate: "2026-01-31" });
    expect(enumerateOccurrences(rule, [], "2026-01-01", "2026-04-30").map((o) => o.occurrenceDate))
      .toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("clamps semi-monthly daysOfMonth past month-end", () => {
    const rule = mkRule({ frequency: "semi-monthly", daysOfMonth: [15, 31], nextDueDate: "2026-02-15" });
    expect(enumerateOccurrences(rule, [], "2026-02-01", "2026-02-28").map((o) => o.occurrenceDate))
      .toEqual(["2026-02-15", "2026-02-28"]);
  });

  it("applies all three weekendShift modes", () => {
    // 2026-08-15 is a Saturday
    for (const [shift, expected] of [
      ["previous-business-day", "2026-08-14"],
      ["next-business-day", "2026-08-17"],
      ["none", "2026-08-15"],
    ] as const) {
      const rule = mkRule({ frequency: "monthly", nextDueDate: "2026-08-15", weekendShift: shift });
      const occs = enumerateOccurrences(rule, [], "2026-08-01", "2026-08-31");
      expect(occs[0]!.date).toBe(expected);
      expect(occs[0]!.occurrenceDate).toBe("2026-08-15"); // identity stays canonical
    }
  });

  it("skips skippedDates and honors endDate", () => {
    const rule = mkRule({
      frequency: "weekly",
      nextDueDate: "2026-10-15",
      skippedDates: ["2026-10-22" as DateOnly],
      endDate: "2026-10-29" as DateOnly,
    });
    expect(enumerateOccurrences(rule, [], "2026-10-15", "2026-11-30").map((o) => o.occurrenceDate))
      .toEqual(["2026-10-15", "2026-10-29"]);
  });

  it("caps at remainingOccurrences counted from nextDueDate", () => {
    const rule = mkRule({ frequency: "monthly", nextDueDate: "2026-10-15", remainingOccurrences: 2 });
    expect(enumerateOccurrences(rule, [], "2026-10-15", "2027-12-31").map((o) => o.occurrenceDate))
      .toEqual(["2026-10-15", "2026-11-15"]);
  });

  it("applies single-occurrence overrides", () => {
    const rule = mkRule({ frequency: "monthly", nextDueDate: "2026-10-15", amount: 1000 });
    const ov = mkOverride({ ruleId: rule.id, occurrenceDate: "2026-11-15", amount: 2500 });
    const occs = enumerateOccurrences(rule, [ov], "2026-10-15", "2026-12-15");
    expect(occs.find((o) => o.occurrenceDate === "2026-11-15")!.amount).toBe(2500);
    expect(occs.find((o) => o.occurrenceDate === "2026-12-15")!.amount).toBe(1000);
  });
});

describe("generation", () => {
  it("generates Scheduled rows for unpaid bills, Pending for autopay", () => {
    const bill = mkRule({ kind: "Bill", autoPay: false });
    expect(generatedStatus(bill)).toBe("Scheduled");
    expect(generatedStatus(mkRule({ kind: "Bill", autoPay: true }))).toBe("Pending");
    expect(generatedStatus(mkRule({ kind: "Income" }))).toBe("Scheduled");
    expect(generatedStatus(mkRule({ kind: "Bill", autoPay: true, isVariableAmount: true }))).toBe(
      "Scheduled",
    );
  });

  it("catches up from lastGeneratedThrough without duplicates", () => {
    const rule = mkRule({ kind: "Bill", frequency: "weekly", nextDueDate: "2026-10-01" });
    const first = generateDueTransactions(rule, [], [], "2026-10-15", NOW);
    expect(first.transactions).toHaveLength(3); // Oct 1, 8, 15
    expect(first.lastGeneratedThrough).toBe("2026-10-15");

    // second run with the watermark: only new occurrences
    const rule2 = { ...rule, lastGeneratedThrough: first.lastGeneratedThrough };
    const second = generateDueTransactions(rule2, [], first.transactions, "2026-10-29", NOW);
    expect(second.transactions.map((t) => t.occurrenceDate)).toEqual(["2026-10-22", "2026-10-29"]);
  });

  it("never regenerates when the editable date moved", () => {
    const rule = mkRule({ kind: "Bill", frequency: "monthly", nextDueDate: "2026-10-15" });
    const existing = [
      mkTransaction({
        recurringRuleId: rule.id,
        occurrenceDate: "2026-10-15",
        date: "2026-10-18", // user moved the payment date
        status: "Scheduled",
      }),
    ];
    const res = generateDueTransactions(rule, [], existing, "2026-10-15", NOW);
    expect(res.transactions).toHaveLength(0);
  });

  it("decrements remainingOccurrences as it generates", () => {
    const rule = mkRule({ frequency: "monthly", nextDueDate: "2026-10-15", remainingOccurrences: 3 });
    const res = generateDueTransactions(rule, [], [], "2027-12-31", NOW);
    expect(res.transactions).toHaveLength(3);
    expect(res.remainingOccurrences).toBe(0);
  });

  it("builds well-formed transaction rows", () => {
    const rule = mkRule({
      kind: "Bill",
      name: "Concord",
      amount: 26400,
      accountId: "acct-9",
      categoryId: "cat-9",
    });
    const res = generateDueTransactions(rule, [], [], "2026-10-15", NOW);
    const t = res.transactions[0]!;
    expect(t.type).toBe("Expense");
    expect(t.amount).toBe(26400);
    expect(t.accountId).toBe("acct-9");
    expect(t.recurringRuleId).toBe(rule.id);
    expect(t.occurrenceDate).toBe("2026-10-15");
    expect(t.status).toBe("Scheduled");
  });
});

describe("projection", () => {
  it("projects without creating rows and skips inactive rules", () => {
    const active = mkRule({ kind: "Bill", name: "Active", frequency: "monthly", nextDueDate: "2026-10-15" });
    const inactive = mkRule({ kind: "Bill", name: "Off", active: false });
    const out = projectOccurrences([active, inactive], [], "2026-10-15", "2026-12-15");
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ ruleId: active.id, kind: "Bill", isCreditCardPayment: false });
  });

  it("flags credit-card-payment rules", () => {
    const rule = mkRule({ kind: "Bill", isCreditCardPayment: true, nextDueDate: "2026-10-15" });
    const out = projectOccurrences([rule], [], "2026-10-15", "2026-10-15");
    expect(out[0]!.isCreditCardPayment).toBe(true);
  });
});

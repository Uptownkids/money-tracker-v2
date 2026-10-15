import { describe, expect, it } from "vitest";
import {
  annualCost,
  enumerateOccurrences,
  setPrimaryPayday,
} from "../src/domain/engine/recurringEngine.js";
import { addDays } from "../src/domain/dates/dateOnly.js";
import type { DateOnly } from "../src/domain/dates/dateOnly.js";
import type { MinorUnits } from "../src/domain/money/money.js";
import { mkOverride, mkRule } from "./helpers.js";

const NOW = "2026-10-15T12:00:00.000Z";

describe("annualCost", () => {
  it("sums 12 monthly occurrences of $10 over the 365-day window", () => {
    // Anchor one day after today: the window [today, today+365] then
    // holds the 16th of Jan..Dec, exactly 12 occurrences.
    const rule = mkRule({
      frequency: "monthly",
      amount: 1000 as MinorUnits,
      nextDueDate: "2026-01-16" as DateOnly,
      weekendShift: "none",
    });
    const today = "2026-01-15" as DateOnly;
    expect(annualCost(rule, [], today)).toBe(12 * 1000);
  });

  it("sums weekly occurrences and matches a direct enumeration", () => {
    const rule = mkRule({
      frequency: "weekly",
      amount: 2500 as MinorUnits,
      nextDueDate: "2026-01-15" as DateOnly,
      weekendShift: "none",
    });
    const today = "2026-01-15" as DateOnly;
    const horizon = addDays(today, 365);
    const expected = enumerateOccurrences(rule, [], today, horizon).reduce(
      (sum, o) => sum + (o.amount as MinorUnits),
      0,
    );
    expect(annualCost(rule, [], today)).toBe(expected);
    // 2026-01-15 + 7k <= 2027-01-15  ->  k = 0..52  ->  53 occurrences.
    expect(annualCost(rule, [], today)).toBe(53 * 2500);
  });

  it("counts an annual rule exactly once when the anchor is yesterday", () => {
    const rule = mkRule({
      frequency: "annual",
      amount: 12000 as MinorUnits,
      nextDueDate: "2026-01-15" as DateOnly,
      weekendShift: "none",
    });
    expect(annualCost(rule, [], "2026-01-16" as DateOnly)).toBe(12000);
  });

  it("respects endDate: a rule ending in 30 days keeps one occurrence", () => {
    const rule = mkRule({
      frequency: "monthly",
      amount: 5000 as MinorUnits,
      nextDueDate: "2026-01-15" as DateOnly,
      endDate: "2026-02-14" as DateOnly,
      weekendShift: "none",
    });
    expect(annualCost(rule, [], "2026-01-15" as DateOnly)).toBe(5000);
  });

  it("applies a single-occurrence amount override", () => {
    const rule = mkRule({
      frequency: "monthly",
      amount: 1000 as MinorUnits,
      nextDueDate: "2026-01-16" as DateOnly,
      weekendShift: "none",
    });
    const override = mkOverride({
      id: `${rule.id}:2026-01-16`,
      ruleId: rule.id,
      occurrenceDate: "2026-01-16" as DateOnly,
      amount: 2500 as MinorUnits,
    });
    // 12 occurrences: one at the overridden 2500, eleven at 1000.
    expect(annualCost(rule, [override], "2026-01-15" as DateOnly)).toBe(2500 + 11 * 1000);
  });
});

describe("setPrimaryPayday", () => {
  it("leaves exactly one primary and clears the previous one", () => {
    const a = mkRule({ kind: "Income", isPrimaryPayday: true });
    const b = mkRule({ kind: "Income", isPrimaryPayday: false });
    const c = mkRule({ kind: "Income", isPrimaryPayday: undefined });
    const next = setPrimaryPayday([a, b, c], b.id, NOW);
    expect(next.filter((r) => r.isPrimaryPayday).map((r) => r.id)).toEqual([b.id]);
    expect(next.find((r) => r.id === a.id)!.isPrimaryPayday).toBe(false);
  });

  it("leaves the list unchanged when the id is not an Income rule", () => {
    const a = mkRule({ kind: "Income", isPrimaryPayday: true });
    const bill = mkRule({ kind: "Bill", isPrimaryPayday: undefined });
    const next = setPrimaryPayday([a, bill], bill.id, NOW);
    expect(next.filter((r) => r.isPrimaryPayday).map((r) => r.id)).toEqual([a.id]);
  });

  it("returns a new array and does not mutate the input", () => {
    const a = mkRule({ kind: "Income", isPrimaryPayday: true });
    const b = mkRule({ kind: "Income", isPrimaryPayday: false });
    const before = [a, b];
    const next = setPrimaryPayday(before, b.id, NOW);
    expect(next).not.toBe(before);
    expect(a.isPrimaryPayday).toBe(true);
    expect(b.isPrimaryPayday).toBe(false);
  });
});

describe("endRule semantics", () => {
  it("endDate = today stops all future enumeration", () => {
    const today = "2026-01-15" as DateOnly;
    const rule = mkRule({
      frequency: "monthly",
      nextDueDate: today,
      endDate: today,
      weekendShift: "none",
    });
    const dates = enumerateOccurrences(rule, [], today, addDays(today, 180)).map(
      (o) => o.occurrenceDate,
    );
    expect(dates).toEqual([today]);
  });

  it("endDate yesterday yields no occurrences at all", () => {
    const today = "2026-01-15" as DateOnly;
    const rule = mkRule({
      frequency: "monthly",
      nextDueDate: today,
      endDate: addDays(today, -1),
      weekendShift: "none",
    });
    expect(enumerateOccurrences(rule, [], today, addDays(today, 180))).toEqual([]);
  });
});

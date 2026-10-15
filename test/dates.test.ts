import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonthsClamped,
  clampDayOfMonth,
  compareDateOnly,
  diffDays,
  endOfMonth,
  isWeekend,
  shiftWeekend,
  startOfMonth,
  todayLocal,
} from "../src/domain/dates/dateOnly.js";
import { enumeratePaydays, resolvePayCycle } from "../src/domain/dates/payCycle.js";
import { mkRule } from "./helpers.js";

describe("dateOnly", () => {
  it("adds days across month boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29"); // leap year
  });

  it("diffs days", () => {
    expect(diffDays("2026-10-15", "2026-10-20")).toBe(5);
    expect(diffDays("2026-10-20", "2026-10-15")).toBe(-5);
    expect(diffDays("2026-10-15", "2026-10-15")).toBe(0);
  });

  it("clamps month arithmetic", () => {
    expect(addMonthsClamped("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsClamped("2024-01-31", 1)).toBe("2024-02-29");
    expect(clampDayOfMonth(2026, 2, 30)).toBe("2026-02-28");
    expect(startOfMonth("2026-10-15")).toBe("2026-10-01");
    expect(endOfMonth("2026-02-10")).toBe("2026-02-28");
  });

  it("rejects invalid dates", () => {
    expect(() => addDays("2026-02-30", 1)).toThrow(RangeError);
    expect(() => addDays("not-a-date", 1)).toThrow(RangeError);
    expect(compareDateOnly("2026-01-01", "2026-01-02")).toBe(-1);
  });

  it("detects weekends and shifts them", () => {
    expect(isWeekend("2026-10-17")).toBe(true); // Saturday
    expect(isWeekend("2026-10-18")).toBe(true); // Sunday
    expect(isWeekend("2026-10-16")).toBe(false); // Friday
    expect(shiftWeekend("2026-10-17", "previous-business-day")).toBe("2026-10-16");
    expect(shiftWeekend("2026-10-18", "previous-business-day")).toBe("2026-10-16");
    expect(shiftWeekend("2026-10-17", "next-business-day")).toBe("2026-10-19");
    expect(shiftWeekend("2026-10-16", "previous-business-day")).toBe("2026-10-16"); // not weekend
    expect(shiftWeekend("2026-10-17", "none")).toBe("2026-10-17");
  });

  it("todayLocal returns a valid date", () => {
    expect(todayLocal()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("payCycle", () => {
  it("resolves semi-monthly [15,30] cycles", () => {
    const rule = mkRule({ kind: "Income", frequency: "semi-monthly", daysOfMonth: [15, 30] });
    // Oct 15 is a payday -> new cycle starts today
    const c = resolvePayCycle("2026-10-15", rule)!;
    expect(c.cycleStart).toBe("2026-10-15");
    expect(c.nextPayday).toBe("2026-10-30");
    expect(c.cycleEnd).toBe("2026-10-29");
    expect(c.daysLeft).toBe(15);
    // Oct 20 sits inside the 15th->30th cycle
    const c2 = resolvePayCycle("2026-10-20", rule)!;
    expect(c2.cycleStart).toBe("2026-10-15");
    expect(c2.nextPayday).toBe("2026-10-30");
    expect(c2.daysLeft).toBe(10);
  });

  it("clamps the 30th in February", () => {
    const rule = mkRule({ kind: "Income", frequency: "semi-monthly", daysOfMonth: [15, 30] });
    const feb = enumeratePaydays(rule, "2026-02-01", "2026-02-28");
    expect(feb).toEqual(["2026-02-15", "2026-02-28"]);
    const c = resolvePayCycle("2026-02-20", rule)!;
    expect(c.nextPayday).toBe("2026-02-28");
  });

  it("shifts weekend paydays per weekendShift", () => {
    // Aug 15 2026 is a Saturday
    const prev = mkRule({
      kind: "Income",
      frequency: "monthly",
      nextDueDate: "2026-08-15",
      weekendShift: "previous-business-day",
    });
    expect(enumeratePaydays(prev, "2026-08-01", "2026-08-31")).toEqual(["2026-08-14"]);
    const next = mkRule({
      kind: "Income",
      frequency: "monthly",
      nextDueDate: "2026-08-15",
      weekendShift: "next-business-day",
    });
    expect(enumeratePaydays(next, "2026-08-01", "2026-08-31")).toEqual(["2026-08-17"]);
    const none = mkRule({
      kind: "Income",
      frequency: "monthly",
      nextDueDate: "2026-08-15",
      weekendShift: "none",
    });
    expect(enumeratePaydays(none, "2026-08-01", "2026-08-31")).toEqual(["2026-08-15"]);
  });

  it("resolves weekly and biweekly cycles", () => {
    const weekly = mkRule({ kind: "Income", frequency: "weekly", nextDueDate: "2026-10-15" });
    const c = resolvePayCycle("2026-10-20", weekly)!;
    expect(c.cycleStart).toBe("2026-10-15");
    expect(c.nextPayday).toBe("2026-10-22");
    expect(c.daysLeft).toBe(2);
  });

  it("returns null without a primary rule", () => {
    expect(resolvePayCycle("2026-10-15", null)).toBeNull();
  });
});

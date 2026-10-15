import { describe, expect, it } from "vitest";
import { buildUpcoming, type BuildUpcomingInput } from "../src/domain/engine/upcoming.js";
import { mkOverride, mkRule, mkTransaction } from "./helpers.js";
import type { MinorUnits } from "../src/domain/money/money.js";
import type { DateOnly } from "../src/domain/dates/dateOnly.js";

const TODAY = "2026-10-15" as DateOnly;

// Identity conversion for USD-only tests.
const convertToBase = (amount: MinorUnits): MinorUnits => amount;
const accountCurrencyOf = () => "USD";

function input(o: Partial<BuildUpcomingInput> = {}): BuildUpcomingInput {
  return {
    rules: [],
    overridesByRule: {},
    transactions: [],
    today: TODAY,
    convertToBase,
    accountCurrencyOf,
    ...o,
  };
}

describe("buildUpcoming", () => {
  it("merges a projection and its Scheduled row into one entry, row wins", () => {
    const rule = mkRule({
      id: "r-electric",
      name: "Electric",
      amount: 1000,
      nextDueDate: "2026-10-20" as DateOnly,
    });
    const row = mkTransaction({
      status: "Scheduled",
      type: "Expense",
      date: "2026-10-20" as DateOnly,
      payee: "Con Ed",
      amount: 2500, // edited amount beats the projection
      recurringRuleId: "r-electric",
      occurrenceDate: "2026-10-20" as DateOnly,
    });
    const items = buildUpcoming(input({ rules: [rule], transactions: [row] }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "r-electric:2026-10-20",
      ruleId: "r-electric",
      name: "Con Ed",
      amount: 2500,
      date: "2026-10-20",
      occurrenceDate: "2026-10-20",
      overdue: false,
      source: "scheduled",
    });
  });

  it("includes overdue Scheduled rows, marked overdue and sorted first", () => {
    const overdue = mkTransaction({
      status: "Scheduled",
      type: "Expense",
      date: "2026-10-10" as DateOnly, // before today, no window start cutoff
      payee: "Late bill",
      amount: 500,
    });
    const rule = mkRule({
      id: "r-future",
      name: "Internet",
      amount: 2000,
      nextDueDate: "2026-10-25" as DateOnly,
    });
    const items = buildUpcoming(input({ rules: [rule], transactions: [overdue] }));
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      name: "Late bill",
      date: "2026-10-10",
      overdue: true,
      source: "scheduled",
    });
    expect(items[1]).toMatchObject({
      name: "Internet",
      date: "2026-10-25",
      overdue: false,
      source: "projected",
    });
  });

  it("keeps the 30-day window inclusive: day 30 in, day 31 out", () => {
    const inWindow = mkRule({
      id: "r-day30",
      name: "Day 30 bill",
      nextDueDate: "2026-11-14" as DateOnly, // today + 30
    });
    const day30Row = mkTransaction({
      status: "Scheduled",
      type: "Expense",
      date: "2026-11-14" as DateOnly, // today + 30
      payee: "Day 30 charge",
      amount: 100,
    });
    const outOfWindowRow = mkTransaction({
      status: "Scheduled",
      type: "Expense",
      date: "2026-11-15" as DateOnly, // today + 31
      payee: "Day 31 charge",
      amount: 100,
    });
    const items = buildUpcoming(
      input({ rules: [inWindow], transactions: [day30Row, outOfWindowRow] }),
    );
    expect(items.map((i) => i.name)).toEqual(["Day 30 bill", "Day 30 charge"]);
  });

  it("sorts by date ascending", () => {
    const rules = [
      mkRule({ id: "r-c", name: "C", nextDueDate: "2026-11-01" as DateOnly }),
      mkRule({ id: "r-a", name: "A", nextDueDate: "2026-10-18" as DateOnly }),
      mkRule({ id: "r-b", name: "B", nextDueDate: "2026-10-25" as DateOnly }),
    ];
    const items = buildUpcoming(input({ rules }));
    expect(items.map((i) => i.date)).toEqual([
      "2026-10-18",
      "2026-10-25",
      "2026-11-01",
    ]);
  });

  it("excludes income rules and income scheduled rows", () => {
    const incomeRule = mkRule({
      id: "r-pay",
      kind: "Income",
      name: "Paycheck",
      amount: 200000,
      nextDueDate: "2026-10-20" as DateOnly,
    });
    const incomeRow = mkTransaction({
      status: "Scheduled",
      type: "Income",
      date: "2026-10-22" as DateOnly,
      payee: "Paycheck",
      amount: 200000,
    });
    const billRule = mkRule({
      id: "r-bill",
      name: "Rent",
      amount: 135000,
      nextDueDate: "2026-10-20" as DateOnly,
    });
    const items = buildUpcoming(
      input({ rules: [incomeRule, billRule], transactions: [incomeRow] }),
    );
    expect(items.map((i) => i.name)).toEqual(["Rent"]);
  });

  it("applies overrides to the projection amount", () => {
    const rule = mkRule({
      id: "r-util",
      name: "Utility",
      amount: 1000,
      nextDueDate: "2026-10-20" as DateOnly,
    });
    const ov = mkOverride({
      id: "r-util:2026-10-20",
      ruleId: "r-util",
      occurrenceDate: "2026-10-20" as DateOnly,
      amount: 1750,
    });
    const items = buildUpcoming(
      input({ rules: [rule], overridesByRule: { "r-util": [ov] } }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ amount: 1750, source: "projected" });
  });

  it("excludes occurrences already settled by a non-Scheduled row", () => {
    const rule = mkRule({
      id: "r-paid",
      name: "Paid bill",
      amount: 1000,
      nextDueDate: TODAY,
    });
    const cleared = mkTransaction({
      status: "Cleared",
      type: "Expense",
      date: TODAY,
      payee: "Paid bill",
      amount: 1000,
      recurringRuleId: "r-paid",
      occurrenceDate: TODAY,
    });
    const items = buildUpcoming(input({ rules: [rule], transactions: [cleared] }));
    expect(items).toHaveLength(0);
  });
});

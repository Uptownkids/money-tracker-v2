import { describe, expect, it } from "vitest";
import { rankTodaysMoves, type MovesContext } from "../src/domain/engine/todaysMoves.js";
import { mkRule, mkSplit, mkTransaction } from "./helpers.js";
import type { ProjectedOccurrence } from "../src/domain/engine/projection.js";

const TODAY = "2026-10-15";

function ctx(o: Partial<MovesContext> = {}): MovesContext {
  return {
    today: TODAY,
    isPaydayToday: false,
    paydayRunCompleted: false,
    scheduledBills: [],
    projectedBills: [],
    rules: [],
    pendingTransactions: [],
    splits: [],
    goals: [],
    ...o,
  };
}

function proj(o: Partial<ProjectedOccurrence> & { ruleId: string }): ProjectedOccurrence {
  return {
    occurrenceDate: TODAY,
    date: TODAY,
    amount: 10000,
    currency: "USD",
    kind: "Bill",
    isCreditCardPayment: false,
    isDebtPayment: false,
    isCardPayment: false,
    ...o,
  };
}

describe("rankTodaysMoves", () => {
  it("ranks overdue bills first, then payday run, then due-soon", () => {
    const overdueRule = mkRule({ id: "r-over", name: "Concord", reminderOffsetDays: 3 });
    const soonRule = mkRule({ id: "r-soon", name: "Internet", reminderOffsetDays: 3 });
    const moves = rankTodaysMoves(
      ctx({
        isPaydayToday: true,
        rules: [overdueRule, soonRule],
        projectedBills: [
          proj({ ruleId: "r-over", amount: 26400, date: "2026-10-12", occurrenceDate: "2026-10-12" }),
          proj({ ruleId: "r-soon", amount: 6200, date: "2026-10-16", occurrenceDate: "2026-10-16" }),
        ],
      }),
    );
    expect(moves.map((m) => m.kind)).toEqual(["overdue-bill", "payday-run", "bill-due-soon"]);
    expect(moves[0]!.title).toContain("Concord");
    expect(moves[0]!.title).toContain("overdue");
    expect(moves[2]!.title).toContain("Internet");
  });

  it("caps at 3 and sorts by priority", () => {
    const rules = ["a", "b", "c", "d"].map((id, i) =>
      mkRule({ id: `r-${id}`, name: `Bill ${id}`, reminderOffsetDays: 3 }),
    );
    const moves = rankTodaysMoves(
      ctx({
        rules,
        projectedBills: rules.map((r, i) =>
          proj({ ruleId: r.id, amount: 1000 * (i + 1), date: `2026-10-1${i}`, occurrenceDate: `2026-10-1${i}` }),
        ),
        pendingTransactions: [
          mkTransaction({ id: "p1", status: "Pending", date: "2026-10-01", payee: "Stale" }),
        ],
        splits: [mkSplit({ id: "s1", person: "Sam", createdAt: "2026-09-01T00:00:00.000Z" })],
      }),
    );
    expect(moves).toHaveLength(3);
    expect(moves.map((m) => m.priority)).toEqual([1, 1, 1]); // four overdue -> top 3
  });

  it("flags stale pending transactions older than 5 days", () => {
    const moves = rankTodaysMoves(
      ctx({
        pendingTransactions: [
          mkTransaction({ id: "p-old", status: "Pending", date: "2026-10-01", payee: "Check" }),
          mkTransaction({ id: "p-new", status: "Pending", date: "2026-10-13", payee: "Recent" }),
        ],
      }),
    );
    expect(moves.map((m) => m.kind)).toEqual(["stale-pending"]);
    expect(moves[0]!.title).toContain("Check");
  });

  it("flags IOUs older than 14 days", () => {
    const moves = rankTodaysMoves(
      ctx({
        splits: [
          mkSplit({ id: "s-old", person: "Sam", direction: "TheyOweMe", createdAt: "2026-09-20T00:00:00.000Z" }),
          mkSplit({ id: "s-new", person: "Jo", direction: "TheyOweMe", createdAt: "2026-10-10T00:00:00.000Z" }),
          mkSplit({ id: "s-owe", person: "Mia", direction: "IOweThem", createdAt: "2026-09-01T00:00:00.000Z" }),
        ],
      }),
    );
    expect(moves).toHaveLength(2);
    expect(moves[0]!.title).toBe("Remind Sam about $50.00");
    expect(moves[1]!.title).toBe("Pay back Mia $50.00");
  });

  it("flags unused subscriptions renewing within 7 days", () => {
    const rule = mkRule({ id: "r-sub", name: "StreamCo", reminderOffsetDays: 3, unusedFlag: true });
    const moves = rankTodaysMoves(
      ctx({
        rules: [rule],
        projectedBills: [
          { ...proj({ ruleId: "r-sub", date: "2026-10-20", occurrenceDate: "2026-10-20" }), kind: "Subscription" },
        ],
      }),
    );
    const sub = moves.find((m) => m.kind === "unused-subscription");
    expect(sub?.title).toContain("Cancel StreamCo?");
  });

  it("skips auto-pay bills in due-soon and completed payday runs", () => {
    const rule = mkRule({ id: "r-auto", name: "Auto", autoPay: true, reminderOffsetDays: 3 });
    const moves = rankTodaysMoves(
      ctx({
        isPaydayToday: true,
        paydayRunCompleted: true,
        rules: [rule],
        projectedBills: [proj({ ruleId: "r-auto", date: "2026-10-16", occurrenceDate: "2026-10-16" })],
      }),
    );
    expect(moves).toHaveLength(0);
  });

  it("returns nothing on a quiet day", () => {
    expect(rankTodaysMoves(ctx())).toHaveLength(0);
  });
});

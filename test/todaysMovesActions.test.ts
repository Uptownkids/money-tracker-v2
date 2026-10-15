/**
 * Today's Moves one-tap actions: mark-paid settles Scheduled rows in
 * place (debt rows stay Transfers), mark-cleared flips Pending rows,
 * and snoozes persist in Dexie across restarts.
 */
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { describe, expect, it, afterEach } from "vitest";
import { MoneyTrackerDB } from "../src/data/db.js";
import { createRepositories } from "../src/data/repositories/index.js";
import {
  billMoveRef,
  markStaleCleared,
  settleBillMove,
} from "../src/domain/engine/moveActions.js";
import {
  rankTodaysMoves,
  type MovesContext,
  type TodaysMove,
} from "../src/domain/engine/todaysMoves.js";
import type { ProjectedOccurrence } from "../src/domain/engine/projection.js";
import { mkRule, mkTransaction } from "./helpers.js";

const TODAY = "2026-10-15";
const NOW = "2026-10-15T12:00:00.000Z";

function billMove(o: Partial<TodaysMove> & { id: string }): TodaysMove {
  return {
    kind: "overdue-bill",
    priority: 1,
    title: "Pay Test bill",
    amount: 26400,
    relatedId: "rule-1",
    actions: ["mark-paid", "snooze", "open"],
    ...o,
  };
}

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

describe("billMoveRef", () => {
  it("parses occurrence and tx keys, rejects non-bill moves", () => {
    expect(
      billMoveRef(billMove({ id: "move:p:rule-1:2026-10-15" })),
    ).toEqual({ kind: "occurrence", ruleId: "rule-1", occurrenceDate: "2026-10-15" });
    expect(billMoveRef(billMove({ id: "move:t:tx-9" }))).toEqual({
      kind: "tx",
      txId: "tx-9",
    });
    expect(
      billMoveRef({
        id: "move:stale:tx-1",
        kind: "stale-pending",
        priority: 4,
        title: "x",
        relatedId: "tx-1",
        actions: ["mark-paid", "open"],
      }),
    ).toBeNull();
  });
});

describe("settleBillMove", () => {
  const rule = mkRule({ id: "rule-1", name: "Concord", amount: 26400, accountId: "chk" });
  const scheduled = () =>
    mkTransaction({
      id: "tx-sched",
      type: "Expense",
      amount: 26400,
      currency: "USD",
      date: "2026-10-12",
      accountId: "chk",
      categoryId: "cat-1",
      payee: "Concord",
      status: "Scheduled",
      recurringRuleId: "rule-1",
      occurrenceDate: "2026-10-15",
    });

  it("settles a Scheduled row in place: status/date move, amount and type untouched", () => {
    const tx = scheduled();
    const { settled, created } = settleBillMove(
      [tx],
      [rule],
      billMove({ id: "move:p:rule-1:2026-10-15" }),
      TODAY,
      NOW,
    );
    expect(created).toBeNull();
    expect(settled).not.toBeNull();
    expect(settled!.id).toBe("tx-sched");
    expect(settled!.status).toBe("Cleared");
    expect(settled!.date).toBe(TODAY);
    expect(settled!.amount).toBe(26400);
    expect(settled!.type).toBe("Expense");
    expect(settled!.recurringRuleId).toBe("rule-1");
    expect(settled!.occurrenceDate).toBe("2026-10-15");
    expect(settled!.updatedAt).toBe(NOW);
  });

  it("settles a t:-keyed Scheduled row by transaction id", () => {
    const tx = mkTransaction({ id: "tx-plain", status: "Scheduled", type: "Expense" });
    const { settled } = settleBillMove(
      [tx],
      [],
      billMove({ id: "move:t:tx-plain", relatedId: "t:tx-plain" }),
      TODAY,
      NOW,
    );
    expect(settled?.id).toBe("tx-plain");
    expect(settled?.status).toBe("Cleared");
    expect(settled?.date).toBe(TODAY);
  });

  it("keeps a debt-payment row a Transfer with its destination intact", () => {
    const debtRule = mkRule({
      id: "rule-debt",
      name: "Credit One minimum",
      payToAccountId: "cc",
      accountId: "chk",
    });
    const debtTx = mkTransaction({
      id: "tx-debt",
      type: "Transfer",
      status: "Scheduled",
      accountId: "chk",
      transferToAccountId: "cc",
      categoryId: null,
      recurringRuleId: "rule-debt",
      occurrenceDate: "2026-10-15",
    });
    const { settled, created } = settleBillMove(
      [debtTx],
      [debtRule],
      billMove({ id: "move:p:rule-debt:2026-10-15", relatedId: "rule-debt" }),
      TODAY,
      NOW,
    );
    expect(created).toBeNull();
    expect(settled?.type).toBe("Transfer");
    expect(settled?.transferToAccountId).toBe("cc");
    expect(settled?.categoryId).toBeNull();
    expect(settled?.status).toBe("Cleared");
  });

  it("creates a Cleared row when the occurrence was never generated (future due-soon)", () => {
    const futureRule = mkRule({
      id: "rule-future",
      name: "Internet",
      amount: 6200,
      accountId: "chk",
      categoryId: "cat-1",
    });
    const move = billMove({
      id: "move:p:rule-future:2026-10-18",
      kind: "bill-due-soon",
      priority: 3,
      relatedId: "rule-future",
      amount: 6200,
    });
    const { settled, created } = settleBillMove([], [futureRule], move, TODAY, NOW);
    expect(settled).toBeNull();
    expect(created).not.toBeNull();
    expect(created).toMatchObject({
      type: "Expense",
      amount: 6200,
      currency: "USD",
      date: TODAY,
      accountId: "chk",
      categoryId: "cat-1",
      payee: "Internet",
      status: "Cleared",
      recurringRuleId: "rule-future",
      occurrenceDate: "2026-10-18",
    });
  });

  it("creates a Transfer for a projection-only debt occurrence", () => {
    const debtRule = mkRule({
      id: "rule-loan",
      name: "Concord minimum",
      amount: 26400,
      accountId: "chk",
      payToAccountId: "loan",
    });
    const move = billMove({
      id: "move:p:rule-loan:2026-10-18",
      kind: "bill-due-soon",
      relatedId: "rule-loan",
    });
    const { created } = settleBillMove([], [debtRule], move, TODAY, NOW);
    expect(created?.type).toBe("Transfer");
    expect(created?.transferToAccountId).toBe("loan");
    expect(created?.categoryId).toBeNull();
    expect(created?.status).toBe("Cleared");
  });

  it("returns nulls when nothing matches", () => {
    const { settled, created } = settleBillMove(
      [],
      [],
      billMove({ id: "move:t:gone", relatedId: "t:gone" }),
      TODAY,
      NOW,
    );
    expect(settled).toBeNull();
    expect(created).toBeNull();
  });

  it("leaves non-Scheduled rows alone", () => {
    const tx = scheduled();
    const cleared = { ...tx, status: "Cleared" as const };
    const { settled, created } = settleBillMove(
      [cleared],
      [rule],
      billMove({ id: "move:p:rule-1:2026-10-15" }),
      TODAY,
      NOW,
    );
    // An already-cleared row is not an open Scheduled row, and a row
    // already exists for the occurrence, so no duplicate is created.
    expect(settled).toBeNull();
    expect(created).toBeNull();
  });
});

describe("markStaleCleared", () => {
  it("flips a Pending row to Cleared", () => {
    const tx = mkTransaction({ id: "tx-p", status: "Pending", payee: "Check" });
    const { cleared } = markStaleCleared([tx], "tx-p", NOW);
    expect(cleared?.id).toBe("tx-p");
    expect(cleared?.status).toBe("Cleared");
    expect(cleared?.payee).toBe("Check");
    expect(cleared?.updatedAt).toBe(NOW);
  });

  it("returns null for unknown or non-Pending ids", () => {
    const tx = mkTransaction({ id: "tx-c", status: "Cleared" });
    expect(markStaleCleared([tx], "tx-c", NOW).cleared).toBeNull();
    expect(markStaleCleared([tx], "nope", NOW).cleared).toBeNull();
  });
});

describe("snoozed moves", () => {
  function overdueCtx(snoozed?: MovesContext["snoozed"]): MovesContext {
    const rule = mkRule({ id: "r-over", name: "Concord", reminderOffsetDays: 3 });
    return ctx({
      rules: [rule],
      projectedBills: [
        proj({ ruleId: "r-over", amount: 26400, date: "2026-10-12", occurrenceDate: "2026-10-12" }),
      ],
      snoozed,
    });
  }

  it("hides a move while snoozedUntil >= today", () => {
    const moves = rankTodaysMoves(
      overdueCtx(new Map([["move:p:r-over:2026-10-12", "2026-10-15"]])),
    );
    expect(moves).toHaveLength(0);
  });

  it("shows the move again after snoozedUntil passes", () => {
    const moves = rankTodaysMoves(
      overdueCtx(new Map([["move:p:r-over:2026-10-12", "2026-10-14"]])),
    );
    expect(moves).toHaveLength(1);
    expect(moves[0]!.id).toBe("move:p:r-over:2026-10-12");
  });

  it("does not let a snoozed move consume a top-3 slot", () => {
    const rules = ["a", "b", "c", "d"].map((id) =>
      mkRule({ id: `r-${id}`, name: `Bill ${id}`, reminderOffsetDays: 3 }),
    );
    const moves = rankTodaysMoves(
      ctx({
        rules,
        projectedBills: rules.map((r, i) =>
          proj({ ruleId: r.id, amount: 1000 * (i + 1), date: `2026-10-1${i}`, occurrenceDate: `2026-10-1${i}` }),
        ),
        // Snooze r-a (first by id sort, so it would take the top slot).
        // Filtering happens before the cap, so r-d backfills to 3.
        snoozed: new Map([["move:p:r-a:2026-10-10", "2026-10-15"]]),
      }),
    );
    expect(moves).toHaveLength(3);
    expect(moves.map((m) => m.id)).not.toContain("move:p:r-a:2026-10-10");
    expect(moves.map((m) => m.id)).toContain("move:p:r-d:2026-10-13");
  });
});

describe("snoozedMoves persistence", () => {
  const dbs: MoneyTrackerDB[] = [];
  afterEach(async () => {
    for (const db of dbs.splice(0)) {
      try {
        await db.delete();
      } catch {
        /* already gone */
      }
    }
  });

  it("persists a snooze across a simulated restart", async () => {
    const name = `snooze-restart-${Date.now()}`;
    const db1 = new MoneyTrackerDB(name);
    dbs.push(db1);
    const repos1 = createRepositories(db1);
    await repos1.snoozedMoves.put({ moveId: "move:p:r-1:2026-10-12", snoozedUntil: "2026-10-15" });
    // Simulated restart: close and re-instantiate against the same db.
    db1.close();

    const db2 = new MoneyTrackerDB(name);
    dbs.push(db2);
    const repos2 = createRepositories(db2);
    const rows = await repos2.snoozedMoves.getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      moveId: "move:p:r-1:2026-10-12",
      snoozedUntil: "2026-10-15",
    });

    // The reloaded snooze still hides the move in the engine.
    const snoozed = new Map(rows.map((r) => [r.moveId, r.snoozedUntil] as const));
    const rule = mkRule({ id: "r-1", name: "Concord", reminderOffsetDays: 3 });
    const moves = rankTodaysMoves(
      ctx({
        rules: [rule],
        projectedBills: [
          proj({ ruleId: "r-1", amount: 26400, date: "2026-10-12", occurrenceDate: "2026-10-12" }),
        ],
        snoozed,
      }),
    );
    expect(moves).toHaveLength(0);
  });

  it("upgrades a version-1 database to version 2 without losing data", async () => {
    const name = `snooze-upgrade-${Date.now()}`;
    // Build a version-1 database the way the old schema declared it.
    const v1 = new Dexie(name);
    v1.version(1).stores({
      accounts: "id, archived",
      categories: "id, kind",
      transactions:
        "id, date, accountId, categoryId, status, recurringRuleId, [recurringRuleId+occurrenceDate], goalId",
      recurringRules: "id, nextDueDate, kind, active, lastGeneratedThrough",
      recurringOverrides: "id, ruleId, [ruleId+occurrenceDate]",
      goals: "id, paused, targetDate",
      splits: "id, settled, person",
      settings: "id",
      paydayRuns: "id, payDate, completed",
      dailySnapshots: "id, date",
    });
    await v1.table("accounts").put({ id: "a1", name: "Checking" });
    v1.close();

    const db = new MoneyTrackerDB(name);
    dbs.push(db);
    const repos = createRepositories(db);
    // Old data survives the upgrade…
    expect(await repos.accounts.getById("a1")).toMatchObject({ name: "Checking" });
    // …and the new store is usable.
    await repos.snoozedMoves.put({ moveId: "move:x", snoozedUntil: "2026-10-15" });
    expect(await repos.snoozedMoves.getById("move:x")).toMatchObject({
      snoozedUntil: "2026-10-15",
    });
  });
});

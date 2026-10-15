/** computeRunningBalances + applyBillEdit + skip-date helpers. */
import { describe, expect, it } from "vitest";
import {
  addSkippedDate,
  applyBillEdit,
  computeRunningBalances,
  rekeyOverrideForMove,
  removeSkippedDate,
} from "../src/domain/engine/ledger.js";
import { enumerateOccurrences, generateDueTransactions } from "../src/domain/engine/recurringEngine.js";
import { projectOccurrences } from "../src/domain/engine/projection.js";
import { mergeCommittedBills } from "../src/domain/engine/safeToSpend.js";
import type { DateOnly } from "../src/domain/dates/dateOnly.js";
import { mkAccount, mkOverride, mkRule, mkTransaction } from "./helpers.js";

const ts = (t: string) => `2026-10-15T${t}.000Z`;

describe("computeRunningBalances", () => {
  it("produces no entry for rows dated before the account's startingDate", () => {
    const cash = mkAccount({ id: "c", startingBalance: 50000, startingDate: "2026-10-15" });
    const before = mkTransaction({
      id: "tx-before",
      type: "Expense",
      amount: 2000,
      date: "2026-10-14",
      accountId: "c",
      status: "Cleared",
    });
    const after = mkTransaction({
      id: "tx-after",
      type: "Expense",
      amount: 1000,
      date: "2026-10-15",
      accountId: "c",
      status: "Cleared",
    });
    const running = computeRunningBalances([cash], [before, after]);
    // The pre-tracking row is history: no running-balance entry, so the
    // ledger labels it "Before tracking started" instead of a balance.
    expect(running["tx-before"]).toBeUndefined();
    expect(running["tx-after"]).toBe(49000);
  });

  it("walks txs chronologically, excludes Scheduled, skips unknown accounts, handles transfers and self-transfers", () => {
    const checking = mkAccount({ id: "acct-checking", name: "Checking", startingBalance: 100000 });
    const savings = mkAccount({ id: "acct-savings", name: "Savings", startingBalance: 50000 });

    const txExpense = mkTransaction({
      id: "tx-expense",
      type: "Expense",
      amount: 2500,
      date: "2026-10-10" as DateOnly,
      accountId: "acct-checking",
      categoryId: "cat-1",
      status: "Cleared",
      createdAt: ts("10:00:01"),
      updatedAt: ts("10:00:01"),
    });
    const txScheduled = mkTransaction({
      id: "tx-scheduled",
      type: "Expense",
      amount: 100,
      date: "2026-10-11" as DateOnly,
      accountId: "acct-checking",
      status: "Scheduled",
      createdAt: ts("10:00:02"),
      updatedAt: ts("10:00:02"),
    });
    const txPending = mkTransaction({
      id: "tx-pending",
      type: "Income",
      amount: 5000,
      date: "2026-10-12" as DateOnly,
      accountId: "acct-savings",
      status: "Pending",
      createdAt: ts("10:00:03"),
      updatedAt: ts("10:00:03"),
    });
    const txTransfer = mkTransaction({
      id: "tx-transfer",
      type: "Transfer",
      amount: 10000,
      date: "2026-10-13" as DateOnly,
      accountId: "acct-checking",
      transferToAccountId: "acct-savings",
      categoryId: null,
      status: "Cleared",
      createdAt: ts("10:00:04"),
      updatedAt: ts("10:00:04"),
    });
    const txSavingsExpense = mkTransaction({
      id: "tx-savings-expense",
      type: "Expense",
      amount: 1500,
      date: "2026-10-14" as DateOnly,
      accountId: "acct-savings",
      status: "Cleared",
      createdAt: ts("10:00:05"),
      updatedAt: ts("10:00:05"),
    });
    const txUnknown = mkTransaction({
      id: "tx-unknown",
      type: "Expense",
      amount: 100,
      date: "2026-10-15" as DateOnly,
      accountId: "acct-nope",
      status: "Cleared",
      createdAt: ts("10:00:06"),
      updatedAt: ts("10:00:06"),
    });
    const txSelfTransfer = mkTransaction({
      id: "tx-self",
      type: "Transfer",
      amount: 5000,
      date: "2026-10-16" as DateOnly,
      accountId: "acct-checking",
      transferToAccountId: "acct-checking",
      categoryId: null,
      status: "Cleared",
      createdAt: ts("10:00:07"),
      updatedAt: ts("10:00:07"),
    });

    // Deliberately shuffled: the ledger must sort by date, then createdAt.
    const result = computeRunningBalances(
      [checking, savings],
      [txUnknown, txSelfTransfer, txTransfer, txPending, txExpense, txScheduled, txSavingsExpense],
    );

    expect(result["tx-expense"]).toBe(97500); // 100000 - 2500
    expect(result["tx-scheduled"]).toBeUndefined(); // Scheduled excluded
    expect(result["tx-pending"]).toBe(55000); // Pending included: 50000 + 5000
    expect(result["tx-transfer"]).toBe(87500); // checking after debit: 97500 - 10000
    // savings side of the transfer: 55000 + 10000 (transfer credit) - 1500
    expect(result["tx-savings-expense"]).toBe(63500);
    expect(result["tx-unknown"]).toBeUndefined(); // unknown account skipped
    expect(result["tx-self"]).toBe(87500); // self-transfer: entry recorded, balance unchanged
    // Scheduled row never touches the running balance even though it is mid-stream
    expect(result["tx-expense"]).toBe(97500);
  });

  it("orders by createdAt when dates tie", () => {
    const checking = mkAccount({ id: "acct-checking", startingBalance: 0 });
    const first = mkTransaction({
      id: "tx-first",
      type: "Income",
      amount: 100,
      date: "2026-10-10" as DateOnly,
      accountId: "acct-checking",
      createdAt: ts("09:00:00"),
      updatedAt: ts("09:00:00"),
    });
    const second = mkTransaction({
      id: "tx-second",
      type: "Income",
      amount: 200,
      date: "2026-10-10" as DateOnly,
      accountId: "acct-checking",
      createdAt: ts("10:00:00"),
      updatedAt: ts("10:00:00"),
    });
    const result = computeRunningBalances([checking], [second, first]);
    expect(result["tx-first"]).toBe(100);
    expect(result["tx-second"]).toBe(300);
  });

  it("uses fx.baseAmount (account currency) instead of amount when present", () => {
    const eur = mkAccount({ id: "acct-eur", startingBalance: 0, currency: "EUR" });
    const tx = mkTransaction({
      id: "tx-fx",
      type: "Expense",
      amount: 1100, // $11.00
      currency: "USD",
      date: "2026-10-10" as DateOnly,
      accountId: "acct-eur",
      status: "Cleared",
      fx: { originalAmount: 1100, originalCurrency: "USD", rate: 0.909090909, baseAmount: 1000 },
    });
    const result = computeRunningBalances([eur], [tx]);
    expect(result["tx-fx"]).toBe(-1000);
  });
});

describe("applyBillEdit", () => {
  const NOW = "2026-10-15T12:00:00.000Z";

  it("occurrence scope returns an override only, without mutating the rule", () => {
    const rule = mkRule({ id: "r1", amount: 5000, accountId: "a1" });
    const before = { ...rule };

    const result = applyBillEdit(
      rule,
      "2026-10-20" as DateOnly,
      { amount: 7000, date: "2026-10-22" as DateOnly },
      NOW,
      "occurrence",
    );

    expect(result.rule).toBeUndefined();
    expect(result.override).toBeDefined();
    expect(result.override?.id).toBe("r1:2026-10-20");
    expect(result.override?.ruleId).toBe("r1");
    expect(result.override?.occurrenceDate).toBe("2026-10-20");
    expect(result.override?.amount).toBe(7000);
    expect(result.override?.date).toBe("2026-10-22");
    expect(result.override?.createdAt).toBe(NOW);
    expect("accountId" in (result.override as object)).toBe(false);
    expect("categoryId" in (result.override as object)).toBe(false);
    expect(rule).toEqual(before); // input untouched
  });

  it("future scope with a date change moves the rule schedule and returns no override", () => {
    const rule = mkRule({
      id: "r1",
      amount: 5000,
      accountId: "a1",
      frequency: "monthly",
      nextDueDate: "2026-10-20" as DateOnly,
      lastGeneratedThrough: "2026-10-01" as DateOnly,
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    const createdAt = rule.createdAt;

    const result = applyBillEdit(
      rule,
      "2026-10-20" as DateOnly,
      { amount: 7000, accountId: "a2", date: "2026-10-22" as DateOnly },
      NOW,
      "future",
    );

    expect(result.rule).toBeDefined();
    expect(result.rule?.amount).toBe(7000);
    expect(result.rule?.accountId).toBe("a2");
    expect(result.rule?.updatedAt).toBe(NOW);
    expect(result.rule?.createdAt).toBe(createdAt);
    // the schedule itself moves forward
    expect(result.rule?.nextDueDate).toBe("2026-10-22");
    expect(result.rule?.lastGeneratedThrough).toBe("2026-10-22");
    // no override: the caller moves the row's date + occurrenceDate, and
    // generation now runs from lastGeneratedThrough + 1
    expect(result.override).toBeUndefined();

    expect(rule.amount).toBe(5000); // input not mutated
    expect(rule.accountId).toBe("a1");
    expect(rule.nextDueDate).toBe("2026-10-20");
    expect(rule.lastGeneratedThrough).toBe("2026-10-01");
  });

  it("future+date keeps the later lastGeneratedThrough and sets it when missing", () => {
    // Watermark already ahead of the new date: keep the later one.
    const ahead = mkRule({
      id: "r-ahead",
      frequency: "monthly",
      nextDueDate: "2026-10-20" as DateOnly,
      lastGeneratedThrough: "2026-10-25" as DateOnly,
    });
    const aheadResult = applyBillEdit(ahead, "2026-10-20" as DateOnly, { date: "2026-10-22" as DateOnly }, NOW, "future");
    expect(aheadResult.rule?.lastGeneratedThrough).toBe("2026-10-25");
    expect(aheadResult.rule?.nextDueDate).toBe("2026-10-22");
    expect(aheadResult.override).toBeUndefined();

    // No watermark: treat as -infinity, becomes the new date.
    const missing = mkRule({
      id: "r-missing",
      frequency: "weekly",
      nextDueDate: "2026-10-20" as DateOnly,
      lastGeneratedThrough: undefined,
    });
    const missingResult = applyBillEdit(
      missing,
      "2026-10-20" as DateOnly,
      { date: "2026-10-22" as DateOnly },
      NOW,
      "future",
    );
    expect(missingResult.rule?.lastGeneratedThrough).toBe("2026-10-22");
  });

  it("future+date on semi-monthly swaps the moved day in daysOfMonth", () => {
    const rule = mkRule({
      id: "r-sm",
      frequency: "semi-monthly",
      daysOfMonth: [10, 25],
      nextDueDate: "2026-11-10" as DateOnly,
      lastGeneratedThrough: "2026-10-10" as DateOnly,
    });

    const result = applyBillEdit(rule, "2026-11-10" as DateOnly, { date: "2026-11-15" as DateOnly }, NOW, "future");

    expect(result.rule?.daysOfMonth).toEqual([15, 25]);
    expect(result.rule?.lastGeneratedThrough).toBe("2026-11-15");
    expect(result.override).toBeUndefined();
    expect(rule.daysOfMonth).toEqual([10, 25]); // input not mutated
  });

  it("future+date on semi-monthly leaves daysOfMonth alone when missing", () => {
    const rule = mkRule({
      id: "r-sm2",
      frequency: "semi-monthly",
      daysOfMonth: undefined,
      nextDueDate: "2026-11-10" as DateOnly,
    });
    const result = applyBillEdit(rule, "2026-11-10" as DateOnly, { date: "2026-11-15" as DateOnly }, NOW, "future");
    expect(result.rule?.daysOfMonth).toBeUndefined();
    expect(result.rule?.nextDueDate).toBe("2026-11-10");
  });

  it("after a future+date move, generation never re-emits the moved occurrence", () => {
    const rule = mkRule({
      id: "r-gen",
      frequency: "monthly",
      nextDueDate: "2026-11-10" as DateOnly,
      lastGeneratedThrough: "2026-10-10" as DateOnly,
      weekendShift: "none",
    });
    const result = applyBillEdit(rule, "2026-11-10" as DateOnly, { date: "2026-11-15" as DateOnly }, NOW, "future");
    const moved = result.rule!;
    // Simulate the caller moving the row: date AND occurrenceDate follow.
    const movedRow = mkTransaction({
      recurringRuleId: "r-gen",
      occurrenceDate: "2026-11-15" as DateOnly,
      date: "2026-11-15" as DateOnly,
      status: "Scheduled",
    });

    const gen = generateDueTransactions(moved, [], [movedRow], "2026-12-31" as DateOnly, NOW);
    const occs = gen.transactions.map((t) => t.occurrenceDate);
    expect(occs).not.toContain("2026-11-15");
    expect(occs).toContain("2026-12-15");
  });

  it("future scope with no date change returns only the rule and leaves the schedule alone", () => {
    const rule = mkRule({ id: "r1", amount: 5000, nextDueDate: "2026-10-20" as DateOnly });
    const result = applyBillEdit(rule, "2026-10-20" as DateOnly, { categoryId: "c9" }, NOW, "future");
    expect(result.rule?.categoryId).toBe("c9");
    expect(result.rule?.nextDueDate).toBe("2026-10-20");
    expect(result.override).toBeUndefined();
  });
});

describe("addSkippedDate / removeSkippedDate", () => {
  it("appends a date, dedupes on repeat, and never mutates the input", () => {
    const rule = mkRule({ skippedDates: ["2026-10-01" as DateOnly] });

    const withSkip = addSkippedDate(rule, "2026-10-15" as DateOnly);
    expect(withSkip).not.toBe(rule);
    expect(withSkip.skippedDates).toEqual(["2026-10-01", "2026-10-15"]);
    // input untouched
    expect(rule.skippedDates).toEqual(["2026-10-01"]);

    // second call with the same date: single entry, still a fresh object
    const deduped = addSkippedDate(withSkip, "2026-10-15" as DateOnly);
    expect(deduped).not.toBe(withSkip);
    expect(deduped.skippedDates).toEqual(["2026-10-01", "2026-10-15"]);
  });

  it("removes a date, no-ops when absent, and never mutates the input", () => {
    const rule = mkRule({ skippedDates: ["2026-10-01" as DateOnly, "2026-10-15" as DateOnly] });

    const unskipped = removeSkippedDate(rule, "2026-10-15" as DateOnly);
    expect(unskipped).not.toBe(rule);
    expect(unskipped.skippedDates).toEqual(["2026-10-01"]);
    // input untouched
    expect(rule.skippedDates).toEqual(["2026-10-01", "2026-10-15"]);

    const noOp = removeSkippedDate(unskipped, "2026-10-20" as DateOnly);
    expect(noOp.skippedDates).toEqual(["2026-10-01"]);
    expect(rule.skippedDates).toEqual(["2026-10-01", "2026-10-15"]);
  });

  it("a skipped occurrence no longer enumerates, and un-skipping restores it", () => {
    const rule = mkRule({
      id: "r-skip",
      frequency: "monthly",
      nextDueDate: "2026-09-15" as DateOnly,
      lastGeneratedThrough: "2026-09-15" as DateOnly,
      weekendShift: "none",
    });
    const dates = (r: ReturnType<typeof mkRule>) =>
      enumerateOccurrences(r, [], "2026-09-15" as DateOnly, "2026-12-31" as DateOnly).map(
        (o) => o.occurrenceDate,
      );

    expect(dates(rule)).toContain("2026-10-15");

    // skip the occurrence and delete its row: it must not come back
    const skipped = addSkippedDate(rule, "2026-10-15" as DateOnly);
    expect(dates(skipped)).not.toContain("2026-10-15");
    expect(dates(skipped)).toContain("2026-11-15"); // neighbors unaffected

    // undo: remove the date and the occurrence enumerates again
    const restored = removeSkippedDate(skipped, "2026-10-15" as DateOnly);
    expect(dates(restored)).toContain("2026-10-15");
  });
});

describe("future+date move: no double-count between projection and row", () => {
  const NOW = "2026-10-15T12:00:00.000Z";

  // Same scenario run twice: (a) the move happens while the bill is still
  // upcoming (asOf 2026-11-10), (b) after it went overdue (asOf 2026-11-18).
  // The mechanics don't depend on asOf: the watermark bump and the row's
  // identity update make both cases converge on one Nov-20 entry.
  for (const asOf of ["2026-11-10" as DateOnly, "2026-11-18" as DateOnly]) {
    it(`moving the 15th to the 20th produces exactly one occurrence on the 20th (asOf ${asOf})`, () => {
      const rule = mkRule({
        id: "r-move",
        frequency: "monthly",
        nextDueDate: "2026-11-15" as DateOnly,
        lastGeneratedThrough: "2026-10-15" as DateOnly,
        amount: 6200,
        weekendShift: "none",
      });
      const row = mkTransaction({
        type: "Expense",
        amount: 6200,
        date: "2026-11-15" as DateOnly,
        occurrenceDate: "2026-11-15" as DateOnly,
        recurringRuleId: "r-move",
        status: "Scheduled",
      });

      const result = applyBillEdit(rule, "2026-11-15" as DateOnly, { date: "2026-11-20" as DateOnly }, NOW, "future");
      const movedRule = result.rule!;
      // Simulate the caller's row update: date AND occurrenceDate follow.
      const movedRow = { ...row, date: "2026-11-20" as DateOnly, occurrenceDate: "2026-11-20" as DateOnly };

      // 1. schedule moved, watermark raised, no override
      expect(movedRule.nextDueDate).toBe("2026-11-20");
      expect(movedRule.lastGeneratedThrough).toBe("2026-11-20");
      expect(result.override).toBeUndefined();

      // 1b. a prior single-occurrence edit follows the move: re-key the
      // override from the old date to the new one (simulate the caller's
      // remove + put). The stale `date` it carried is dropped.
      const priorOverrides = [
        mkOverride({
          id: "r-move:2026-11-15",
          ruleId: "r-move",
          occurrenceDate: "2026-11-15" as DateOnly,
          amount: 7000,
          date: "2026-11-16" as DateOnly,
        }),
      ];
      const rekeyed = rekeyOverrideForMove(priorOverrides, "r-move", "2026-11-15" as DateOnly, "2026-11-20" as DateOnly);
      expect(rekeyed).not.toBeNull();
      const persistedOverrides = [
        ...priorOverrides.filter((o) => o.id !== rekeyed!.deleteId),
        rekeyed!.override,
      ];
      expect(persistedOverrides.map((o) => o.id)).toEqual(["r-move:2026-11-20"]);
      expect(persistedOverrides[0]?.occurrenceDate).toBe("2026-11-20");
      expect(persistedOverrides[0]?.amount).toBe(7000);
      expect("date" in (persistedOverrides[0] as object)).toBe(false);

      // 2. committed counts exactly one Nov-20 entry: projection and row
      // share the (ruleId, occurrenceDate) key, the Scheduled row wins.
      const merged = mergeCommittedBills(
        projectOccurrences([movedRule], persistedOverrides, "2026-11-01" as DateOnly, "2026-12-31" as DateOnly),
        [movedRow],
        (amt) => amt,
        () => "USD",
      );
      const nov20 = merged.filter((m) => m.occurrenceDate === "2026-11-20");
      expect(nov20).toHaveLength(1);
      expect(nov20[0]?.amount).toBe(6200);
      // the only other entry is the December occurrence
      expect(merged).toHaveLength(2);

      // 3. the moved occurrence is never regenerated
      const gen = generateDueTransactions(movedRule, persistedOverrides, [movedRow], "2026-12-31" as DateOnly, NOW);
      expect(gen.transactions.map((t) => t.occurrenceDate)).not.toContain("2026-11-20");

      // 4. the schedule continues on the new day
      expect(gen.transactions.map((t) => t.occurrenceDate)).toContain("2026-12-20");
    });
  }
});

describe("rekeyOverrideForMove", () => {
  const NOW = "2026-10-15T12:00:00.000Z";

  it("re-keys the override to the new date, preserving other fields", () => {
    const overrides = [
      mkOverride({
        id: "r1:2026-11-15",
        ruleId: "r1",
        occurrenceDate: "2026-11-15" as DateOnly,
        amount: 7000,
        accountId: "a9",
        categoryId: "c9",
        createdAt: NOW,
      }),
    ];

    const result = rekeyOverrideForMove(overrides, "r1", "2026-11-15" as DateOnly, "2026-11-20" as DateOnly);

    expect(result).not.toBeNull();
    expect(result?.deleteId).toBe("r1:2026-11-15");
    expect(result?.override.id).toBe("r1:2026-11-20");
    expect(result?.override.occurrenceDate).toBe("2026-11-20");
    expect(result?.override.ruleId).toBe("r1");
    expect(result?.override.amount).toBe(7000);
    expect(result?.override.accountId).toBe("a9");
    expect(result?.override.categoryId).toBe("c9");
    expect(result?.override.createdAt).toBe(NOW);
    // input not mutated
    expect(overrides[0]?.id).toBe("r1:2026-11-15");
    expect(overrides[0]?.occurrenceDate).toBe("2026-11-15");
  });

  it("drops a stale date field so the move's new date wins", () => {
    const overrides = [
      mkOverride({
        id: "r1:2026-11-15",
        ruleId: "r1",
        occurrenceDate: "2026-11-15" as DateOnly,
        date: "2026-11-16" as DateOnly,
        amount: 7000,
      }),
    ];

    const result = rekeyOverrideForMove(overrides, "r1", "2026-11-15" as DateOnly, "2026-11-20" as DateOnly);

    expect(result?.override.id).toBe("r1:2026-11-20");
    expect("date" in (result?.override as object)).toBe(false);
    expect(result?.override.amount).toBe(7000);
  });

  it("returns null when no override exists for the old occurrence", () => {
    expect(rekeyOverrideForMove([], "r1", "2026-11-15" as DateOnly, "2026-11-20" as DateOnly)).toBeNull();
    const unrelated = [
      mkOverride({
        id: "r1:2026-11-16",
        ruleId: "r1",
        occurrenceDate: "2026-11-16" as DateOnly,
        amount: 7000,
      }),
    ];
    expect(rekeyOverrideForMove(unrelated, "r1", "2026-11-15" as DateOnly, "2026-11-20" as DateOnly)).toBeNull();
    // same occurrence date, different rule: no match
    expect(rekeyOverrideForMove(unrelated, "r2", "2026-11-16" as DateOnly, "2026-11-20" as DateOnly)).toBeNull();
  });
});

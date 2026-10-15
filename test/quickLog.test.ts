/** parseDollarsToMinor + saveQuickLog, demo and real DB isolation. */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { MoneyTrackerDB, getDemoDb, setDemoMode } from "../src/data/db.js";
import { createRepositories } from "../src/data/repositories/index.js";
import { wipeDemoData } from "../src/app/seed.js";
import {
  findBillMatch,
  parseDollarsToMinor,
  payeeCompletions,
  saveQuickLog,
  suggestPayee,
} from "../src/app/quickLog.js";
import type { DateOnly } from "../src/domain/dates/dateOnly.js";
import type { Transaction } from "../src/domain/entities/transaction.js";
import { deriveBalances } from "../src/domain/engine/balances.js";
import { earmarkedInSpendable } from "../src/domain/engine/goals.js";
import { computeTodaySpending } from "../src/domain/engine/safeToSpend.js";
import { addDays } from "../src/domain/dates/dateOnly.js";
import { mkAccount, mkCategory, mkGoal, mkTransaction, ACCTS } from "./helpers.js";

afterEach(async () => {
  await wipeDemoData().catch(() => {});
});

const seedAccountAndCategory = async (accountId: string) => {
  const repos = createRepositories(getDemoDb());
  await repos.accounts.put(mkAccount({ id: accountId, name: "Checking", currency: "USD" }));
  await repos.categories.put(mkCategory({ id: "ql-cat", name: "Food", kind: "expense" }));
};

describe("parseDollarsToMinor", () => {
  it("parses common inputs", () => {
    expect(parseDollarsToMinor("$1,234.56")).toBe(123456);
    expect(parseDollarsToMinor("12.34")).toBe(1234);
    expect(parseDollarsToMinor("12")).toBe(1200);
    expect(parseDollarsToMinor("  7.5 ")).toBe(750);
    expect(parseDollarsToMinor("$5")).toBe(500);
  });
  it("rejects bad inputs", () => {
    expect(parseDollarsToMinor("")).toBeNull();
    expect(parseDollarsToMinor("   ")).toBeNull();
    expect(parseDollarsToMinor("abc")).toBeNull();
    expect(parseDollarsToMinor("-5")).toBeNull();
    expect(parseDollarsToMinor("0")).toBeNull();
    expect(parseDollarsToMinor("0.00")).toBeNull();
    expect(parseDollarsToMinor("12.345")).toBeNull();
    expect(parseDollarsToMinor("5.")).toBeNull();
    expect(parseDollarsToMinor("$1,23.4.5")).toBeNull();
  });
  it("respects currency decimals", () => {
    expect(parseDollarsToMinor("12", "JPY")).toBe(12);
    expect(parseDollarsToMinor("12.5", "JPY")).toBeNull();
    expect(parseDollarsToMinor("12.345", "KWD")).toBe(12345);
    expect(parseDollarsToMinor("12.3456", "KWD")).toBeNull();
  });
});

describe("saveQuickLog", () => {
  it("persists an Expense to the demo db in demo mode", async () => {
    setDemoMode(true);
    try {
      await seedAccountAndCategory("ql-acct");
      const repos = createRepositories(getDemoDb());
      const { transaction } = await saveQuickLog(repos, {
        type: "Expense",
        amountMinor: 1234,
        accountId: "ql-acct",
        categoryId: "ql-cat",
        payee: "Grocer",
        date: "2026-10-15" as DateOnly,
        notes: "weekly shop",
      });

      expect(transaction.status).toBe("Cleared");
      expect(transaction.currency).toBe("USD");
      expect(transaction.tags).toEqual([]);
      expect(typeof transaction.id).toBe("string");

      const rows = await repos.transactions.getAll();
      expect(rows).toHaveLength(1);
      const row = rows[0] as NonNullable<typeof rows[number]>;
      expect(row.amount).toBe(1234);
      expect(row.accountId).toBe("ql-acct");
      expect(row.payee).toBe("Grocer");
      expect(row.status).toBe("Cleared");
      expect(row.type).toBe("Expense");
      expect(row.categoryId).toBe("ql-cat");
      expect(row.notes).toBe("weekly shop");
    } finally {
      setDemoMode(false);
    }
  });

  it("persists a Transfer to the real db and never touches the demo db", async () => {
    setDemoMode(false);
    const realDb = new MoneyTrackerDB(`ql-real-${Date.now()}`);
    try {
      const realRepos = createRepositories(realDb);
      await realRepos.accounts.put(mkAccount({ id: "r-checking", name: "Checking" }));
      await realRepos.accounts.put(mkAccount({ id: "r-savings", name: "Savings" }));

      const { transaction } = await saveQuickLog(realRepos, {
        type: "Transfer",
        amountMinor: 5000,
        accountId: "r-checking",
        toAccountId: "r-savings",
        categoryId: "ql-cat", // must be forced to null for transfers
        payee: "Move to savings",
        date: "2026-10-15" as DateOnly,
      });

      expect(transaction.transferToAccountId).toBe("r-savings");
      expect(transaction.categoryId).toBeNull();
      expect(transaction.status).toBe("Cleared");

      expect(await realRepos.transactions.count()).toBe(1);

      const demoRepos = createRepositories(getDemoDb());
      expect(await demoRepos.transactions.count()).toBe(0);
    } finally {
      await realDb.delete();
    }
  });

  it("validates input with clear errors", async () => {
    setDemoMode(true);
    try {
      await seedAccountAndCategory("ql-acct");
      const repos = createRepositories(getDemoDb());
      const base = {
        type: "Expense" as const,
        accountId: "ql-acct",
        categoryId: "ql-cat" as string | null,
        payee: "X",
        date: "2026-10-15" as DateOnly,
      };

      await expect(saveQuickLog(repos, { ...base, amountMinor: 0 })).rejects.toThrow(/positive/);
      await expect(saveQuickLog(repos, { ...base, amountMinor: 1.5 })).rejects.toThrow();
      await expect(
        saveQuickLog(repos, { ...base, amountMinor: 100, accountId: "acct-nope" }),
      ).rejects.toThrow(/unknown accountId/);
      await expect(
        saveQuickLog(repos, {
          type: "Transfer",
          amountMinor: 100,
          accountId: "ql-acct",
          categoryId: null,
          payee: "X",
          date: "2026-10-15" as DateOnly,
        }),
      ).rejects.toThrow(/toAccountId/);
      await expect(
        saveQuickLog(repos, {
          type: "Transfer",
          amountMinor: 100,
          accountId: "ql-acct",
          toAccountId: "acct-nope",
          categoryId: null,
          payee: "X",
          date: "2026-10-15" as DateOnly,
        }),
      ).rejects.toThrow(/unknown toAccountId/);
      // nothing persisted through failed writes
      expect(await repos.transactions.count()).toBe(0);
    } finally {
      setDemoMode(false);
    }
  });

  it("rejects a transfer between the same account", async () => {
    setDemoMode(true);
    try {
      await seedAccountAndCategory("ql-acct");
      const repos = createRepositories(getDemoDb());
      await expect(
        saveQuickLog(repos, {
          type: "Transfer",
          amountMinor: 100,
          accountId: "ql-acct",
          toAccountId: "ql-acct",
          categoryId: null,
          payee: "X",
          date: "2026-10-15" as DateOnly,
        }),
      ).rejects.toThrow("Pick two different accounts for a transfer.");
      expect(await repos.transactions.count()).toBe(0);
    } finally {
      setDemoMode(false);
    }
  });

  describe("settleScheduledId", () => {
    const seedBill = async (
      repos: ReturnType<typeof createRepositories>,
      overrides: Partial<Transaction> = {},
    ) => {
      const bill = mkTransaction({
        type: "Expense",
        amount: 12000,
        date: "2026-10-18" as DateOnly,
        accountId: "ql-acct",
        categoryId: "ql-cat",
        payee: "Con Edison",
        status: "Scheduled",
        recurringRuleId: "rule-1",
        occurrenceDate: "2026-10-18" as DateOnly,
        ...overrides,
      });
      await repos.transactions.put(bill);
      return bill;
    };

    it("settles the Scheduled row in place and creates no new transaction", async () => {
      setDemoMode(true);
      try {
        await seedAccountAndCategory("ql-acct");
        const repos = createRepositories(getDemoDb());
        const bill = await seedBill(repos);
        const before = await repos.transactions.count();

        const { transaction } = await saveQuickLog(repos, {
          type: "Expense",
          amountMinor: 11850,
          accountId: "ql-acct",
          categoryId: "ql-cat",
          payee: "Con Ed",
          date: "2026-10-15" as DateOnly,
          settleScheduledId: bill.id,
        });

        expect(transaction.id).toBe(bill.id);
        expect(transaction.status).toBe("Cleared");
        expect(transaction.amount).toBe(11850);
        expect(transaction.date).toBe("2026-10-15");
        // untouched fields
        expect(transaction.recurringRuleId).toBe("rule-1");
        expect(transaction.occurrenceDate).toBe("2026-10-18");
        expect(transaction.categoryId).toBe("ql-cat");
        expect(transaction.payee).toBe("Con Edison");
        expect(await repos.transactions.count()).toBe(before);

        const row = await repos.transactions.getById(bill.id);
        expect(row?.status).toBe("Cleared");
        expect(row?.amount).toBe(11850);
      } finally {
        setDemoMode(false);
      }
    });

    it("settling a card-payment Transfer keeps it a Transfer", async () => {
      setDemoMode(true);
      try {
        await seedAccountAndCategory("ql-acct");
        const repos = createRepositories(getDemoDb());
        await repos.accounts.put(
          mkAccount({ id: "ql-card", name: "Aspire", type: "CreditCard", countsAsSpendable: false }),
        );
        await repos.accounts.put(mkAccount({ id: "ql-checking", name: "Checking" }));
        const bill = await seedBill(repos, {
          type: "Transfer",
          amount: 32191,
          payee: "Aspire minimum",
          categoryId: null,
          transferToAccountId: "ql-card",
          recurringRuleId: "rule-card",
        });
        const before = await repos.transactions.count();

        const { transaction } = await saveQuickLog(repos, {
          type: "Expense",
          amountMinor: 32191,
          accountId: "ql-checking",
          categoryId: "ql-cat",
          payee: "Aspire",
          date: "2026-10-15" as DateOnly,
          settleScheduledId: bill.id,
        });

        expect(transaction.id).toBe(bill.id);
        expect(transaction.status).toBe("Cleared");
        // Debt payments are transfers, never expenses: the settle path must
        // not convert the row's type or touch its destination account.
        expect(transaction.type).toBe("Transfer");
        expect(transaction.transferToAccountId).toBe("ql-card");
        // ...but the paying account follows the Quick-Log pick, not the rule.
        expect(transaction.accountId).toBe("ql-checking");
        expect(transaction.amount).toBe(32191);
        expect(transaction.date).toBe("2026-10-15");
        expect(transaction.recurringRuleId).toBe("rule-card");
        expect(transaction.occurrenceDate).toBe("2026-10-18");
        expect(await repos.transactions.count()).toBe(before);

        const row = await repos.transactions.getById(bill.id);
        expect(row?.type).toBe("Transfer");
        expect(row?.transferToAccountId).toBe("ql-card");
        expect(row?.accountId).toBe("ql-checking");
      } finally {
        setDemoMode(false);
      }
    });

    it("rejects settling a debt Transfer from the account being paid", async () => {
      setDemoMode(true);
      try {
        await seedAccountAndCategory("ql-acct");
        const repos = createRepositories(getDemoDb());
        await repos.accounts.put(
          mkAccount({ id: "ql-card", name: "Aspire", type: "CreditCard", countsAsSpendable: false }),
        );
        const bill = await seedBill(repos, {
          type: "Transfer",
          amount: 32191,
          payee: "Aspire minimum",
          categoryId: null,
          transferToAccountId: "ql-card",
          recurringRuleId: "rule-card",
        });
        await expect(
          saveQuickLog(repos, {
            type: "Expense",
            amountMinor: 32191,
            accountId: "ql-card",
            categoryId: "ql-cat",
            payee: "Aspire",
            date: "2026-10-15" as DateOnly,
            settleScheduledId: bill.id,
          }),
        ).rejects.toThrow("Pick a different account than the one being paid.");
      } finally {
        setDemoMode(false);
      }
    });

    it("settling a migrated Concord loan payment from Checking moves money out of Checking, not Cash", async () => {
      setDemoMode(true);
      try {
        const repos = createRepositories(getDemoDb());
        const cash = mkAccount({ id: "ql-cash", name: "Cash", startingBalance: 50000 });
        const checking = mkAccount({ id: "ql-checking", name: "Checking", startingBalance: 80000 });
        const concord = mkAccount({
          id: "ql-concord",
          name: "Concord",
          type: "Loan",
          countsAsSpendable: false,
          startingBalance: -148835,
        });
        await repos.accounts.put(cash);
        await repos.accounts.put(checking);
        await repos.accounts.put(concord);
        // Migrated debt minimum: generated from the rule whose accountId is
        // the Cash account, paying down the Concord loan.
        const bill = mkTransaction({
          type: "Transfer",
          amount: 26400,
          date: "2026-10-15" as DateOnly,
          accountId: "ql-cash",
          categoryId: null,
          payee: "Concord minimum",
          status: "Scheduled",
          transferToAccountId: "ql-concord",
          recurringRuleId: "rule-concord",
          occurrenceDate: "2026-10-15" as DateOnly,
        });
        await repos.transactions.put(bill);

        const { transaction } = await saveQuickLog(repos, {
          type: "Expense",
          amountMinor: 26400,
          accountId: "ql-checking",
          categoryId: null,
          payee: "Concord",
          date: "2026-10-15" as DateOnly,
          settleScheduledId: bill.id,
        });

        expect(transaction.type).toBe("Transfer");
        expect(transaction.status).toBe("Cleared");
        expect(transaction.accountId).toBe("ql-checking");
        expect(transaction.transferToAccountId).toBe("ql-concord");
        expect(transaction.amount).toBe(26400);

        const balances = deriveBalances([cash, checking, concord], [transaction]);
        expect(balances["ql-checking"]).toBe(80000 - 26400);
        expect(balances["ql-cash"]).toBe(50000);
        expect(balances["ql-concord"]).toBe(-148835 + 26400);
      } finally {
        setDemoMode(false);
      }
    });

    it("settle keeps the fx freeze only when amount and account are both untouched", async () => {
      setDemoMode(true);
      try {
        const repos = createRepositories(getDemoDb());
        await repos.accounts.put(mkAccount({ id: "ql-eur", name: "EUR acct", currency: "EUR" }));
        await repos.accounts.put(mkAccount({ id: "ql-acct", name: "Checking", currency: "USD" }));
        const fxBill = (id: string) =>
          mkTransaction({
            id,
            type: "Expense",
            amount: 10000,
            currency: "EUR",
            date: "2026-10-18" as DateOnly,
            accountId: "ql-eur",
            categoryId: "ql-cat",
            payee: "Foreign bill",
            status: "Scheduled",
            fx: { originalAmount: 10000, originalCurrency: "EUR", rate: 1.1, baseAmount: 11000 },
            recurringRuleId: "rule-fx",
            occurrenceDate: "2026-10-18" as DateOnly,
          });

        // Same amount, same account: the currency/fx triple survives.
        await repos.transactions.put(fxBill("fx-1"));
        const kept = await saveQuickLog(repos, {
          type: "Expense",
          amountMinor: 10000,
          accountId: "ql-eur",
          categoryId: "ql-cat",
          payee: "Foreign bill",
          date: "2026-10-15" as DateOnly,
          settleScheduledId: "fx-1",
        });
        expect(kept.transaction.currency).toBe("EUR");
        expect(kept.transaction.fx).toEqual({
          originalAmount: 10000,
          originalCurrency: "EUR",
          rate: 1.1,
          baseAmount: 11000,
        });

        // Same amount, different account: stale freeze goes, currency follows the pick.
        await repos.transactions.put(fxBill("fx-2"));
        const moved = await saveQuickLog(repos, {
          type: "Expense",
          amountMinor: 10000,
          accountId: "ql-acct",
          categoryId: "ql-cat",
          payee: "Foreign bill",
          date: "2026-10-15" as DateOnly,
          settleScheduledId: "fx-2",
        });
        expect(moved.transaction.accountId).toBe("ql-acct");
        expect(moved.transaction.currency).toBe("USD");
        expect(moved.transaction.fx).toBeUndefined();
      } finally {
        setDemoMode(false);
      }
    });

    it("throws for an unknown or non-Scheduled settleScheduledId", async () => {
      setDemoMode(true);
      try {
        await seedAccountAndCategory("ql-acct");
        const repos = createRepositories(getDemoDb());
        const cleared = await seedBill(repos, { status: "Cleared" });
        const base = {
          type: "Expense" as const,
          amountMinor: 100,
          accountId: "ql-acct",
          categoryId: "ql-cat" as string | null,
          payee: "X",
          date: "2026-10-15" as DateOnly,
        };
        await expect(
          saveQuickLog(repos, { ...base, settleScheduledId: "tx-nope" }),
        ).rejects.toThrow(/unknown settleScheduledId/);
        await expect(
          saveQuickLog(repos, { ...base, settleScheduledId: cleared.id }),
        ).rejects.toThrow(/not Scheduled/);
      } finally {
        setDemoMode(false);
      }
    });
  });

  it("decline path: a normal save creates a new expense", async () => {
    setDemoMode(true);
    try {
      await seedAccountAndCategory("ql-acct");
      const repos = createRepositories(getDemoDb());
      await repos.transactions.put(
        mkTransaction({
          type: "Expense",
          amount: 12000,
          date: "2026-10-18" as DateOnly,
          accountId: "ql-acct",
          categoryId: "ql-cat",
          payee: "Con Edison",
          status: "Scheduled",
          recurringRuleId: "rule-1",
        }),
      );
      const before = await repos.transactions.count();

      const { transaction } = await saveQuickLog(repos, {
        type: "Expense",
        amountMinor: 11850,
        accountId: "ql-acct",
        categoryId: "ql-cat",
        payee: "Con Ed",
        date: "2026-10-15" as DateOnly,
      });

      expect(await repos.transactions.count()).toBe(before + 1);
      expect(transaction.status).toBe("Cleared");
      expect(transaction.payee).toBe("Con Ed");
      expect(transaction.recurringRuleId).toBeUndefined();
    } finally {
      setDemoMode(false);
    }
  });
});

describe("suggestPayee", () => {
  const txs = () => [
    mkTransaction({
      payee: "Whole Foods",
      categoryId: "cat-old",
      accountId: "acct-old",
      date: "2026-10-10" as DateOnly,
      createdAt: "2026-10-10T10:00:00.000Z",
    }),
    mkTransaction({
      payee: "whole foods market",
      categoryId: "cat-new",
      accountId: "acct-new",
      date: "2026-10-14" as DateOnly,
      createdAt: "2026-10-14T10:00:00.000Z",
    }),
    mkTransaction({
      payee: "Trader Joes",
      categoryId: "cat-tj",
      accountId: "acct-tj",
      date: "2026-10-13" as DateOnly,
    }),
  ];

  it("prefills category+account from the most recent matching tx", () => {
    const s = suggestPayee(txs(), "whole");
    expect(s).not.toBeNull();
    expect(s?.payee).toBe("whole foods market");
    expect(s?.categoryId).toBe("cat-new");
    expect(s?.accountId).toBe("acct-new");
  });

  it("matches case-insensitively on a trimmed prefix", () => {
    const s = suggestPayee(txs(), "  WHO");
    expect(s?.payee).toBe("whole foods market");
    const s2 = suggestPayee(txs(), "trader");
    expect(s2?.payee).toBe("Trader Joes");
    expect(s2?.categoryId).toBe("cat-tj");
  });

  it("returns null when nothing matches", () => {
    expect(suggestPayee(txs(), "zzz")).toBeNull();
    expect(suggestPayee([], "whole")).toBeNull();
  });

  it("returns null for an empty prefix", () => {
    expect(suggestPayee(txs(), "")).toBeNull();
    expect(suggestPayee(txs(), "   ")).toBeNull();
  });

  it("breaks date ties by createdAt", () => {
    const rows = [
      mkTransaction({
        payee: "Same Day",
        categoryId: "cat-a",
        accountId: "acct-a",
        date: "2026-10-14" as DateOnly,
        createdAt: "2026-10-14T08:00:00.000Z",
      }),
      mkTransaction({
        payee: "Same Day Later",
        categoryId: "cat-b",
        accountId: "acct-b",
        date: "2026-10-14" as DateOnly,
        createdAt: "2026-10-14T18:00:00.000Z",
      }),
    ];
    const s = suggestPayee(rows, "same");
    expect(s?.categoryId).toBe("cat-b");
  });
});

describe("payeeCompletions", () => {
  const txs = () => [
    mkTransaction({ payee: "Whole Foods", date: "2026-10-10" as DateOnly }),
    mkTransaction({ payee: "whole foods market", date: "2026-10-14" as DateOnly }),
    mkTransaction({ payee: "Whole Foods", date: "2026-10-12" as DateOnly }),
    mkTransaction({ payee: "Trader Joes", date: "2026-10-13" as DateOnly }),
  ];

  it("returns unique payees, most-recent-first", () => {
    expect(payeeCompletions(txs(), "whole")).toEqual([
      "whole foods market",
      "Whole Foods",
    ]);
  });

  it("caps results at the limit", () => {
    expect(payeeCompletions(txs(), "whole", 1)).toEqual(["whole foods market"]);
    expect(payeeCompletions(txs(), "", 6)).toEqual([]);
  });

  it("returns [] when nothing matches", () => {
    expect(payeeCompletions(txs(), "zzz")).toEqual([]);
  });
});

describe("findBillMatch", () => {
  const INPUT_DATE = "2026-10-15" as DateOnly;
  const bill = (overrides: Partial<Transaction> = {}) =>
    mkTransaction({
      type: "Expense",
      amount: 12000,
      date: addDays(INPUT_DATE, 3),
      accountId: "acct-1",
      categoryId: "cat-1",
      payee: "Con Edison",
      status: "Scheduled",
      recurringRuleId: "rule-1",
      occurrenceDate: addDays(INPUT_DATE, 3),
      ...overrides,
    });
  const input = (overrides: Partial<{ payee: string; amountMinor: number; date: DateOnly }> = {}) => ({
    payee: "Con Ed",
    amountMinor: 12000,
    date: INPUT_DATE,
    ...overrides,
  });

  it("finds a payee match for a bill due in 3 days", () => {
    const match = findBillMatch([bill()], input());
    expect(match?.transaction.payee).toBe("Con Edison");
  });

  it("matches a card-payment Transfer row (Scheduled, non-Income, has recurringRuleId)", () => {
    const transfer = bill({
      type: "Transfer",
      payee: "Aspire minimum",
      transferToAccountId: "card-1",
      categoryId: null,
      recurringRuleId: "rule-card",
    });
    const match = findBillMatch([transfer], input({ payee: "Aspire", amountMinor: 12000 }));
    expect(match?.transaction.id).toBe(transfer.id);
    expect(match?.transaction.type).toBe("Transfer");
  });

  it("finds an overdue bill by payee", () => {
    const overdue = bill({ date: addDays(INPUT_DATE, -2), amount: 999 });
    const match = findBillMatch([overdue], input({ payee: "con edison", amountMinor: 100 }));
    expect(match?.transaction.id).toBe(overdue.id);
  });

  it("finds an amount-only match with a different payee", () => {
    const different = bill({ payee: "Some Other Vendor" });
    const match = findBillMatch([different], input({ payee: "Coffee Shop" }));
    expect(match?.transaction.id).toBe(different.id);
  });

  it("returns null when the only bill is due 30 days out", () => {
    const far = bill({ date: addDays(INPUT_DATE, 30) });
    expect(findBillMatch([far], input({ payee: "zzz no match", amountMinor: 1 }))).toBeNull();
  });

  it("never matches Pending or Cleared rows, only Scheduled", () => {
    const rows = [
      bill({ status: "Pending" }),
      bill({ status: "Cleared" }),
      bill({ status: "Scheduled", recurringRuleId: undefined }),
    ];
    expect(findBillMatch(rows, input())).toBeNull();
  });

  it("ignores Income rows and rows without a recurringRuleId", () => {
    const rows = [
      bill({ type: "Income" }),
      bill({ recurringRuleId: "" }),
    ];
    expect(findBillMatch(rows, input({ payee: "zzz", amountMinor: 1 }))).toBeNull();
  });

  it("ranks a payee match above an amount-only match", () => {
    const payeeBill = bill({ payee: "Con Edison", amount: 9999, date: addDays(INPUT_DATE, 5) });
    const amountBill = bill({ payee: "Random Vendor", amount: 12000, date: addDays(INPUT_DATE, 1) });
    const match = findBillMatch([amountBill, payeeBill], input({ payee: "con ed" }));
    expect(match?.transaction.id).toBe(payeeBill.id);
  });

  it("breaks payee-match ties by closest date", () => {
    const near = bill({ payee: "Con Edison", date: addDays(INPUT_DATE, 1) });
    const far = bill({ payee: "Con Edison NYC", date: addDays(INPUT_DATE, 5) });
    const match = findBillMatch([far, near], input({ payee: "con ed" }));
    expect(match?.transaction.id).toBe(near.id);
  });

  it("ignores a payee match when the entered payee is under 3 characters", () => {
    // "Co" is a substring of "Con Edison" but too short to count.
    expect(findBillMatch([bill()], input({ payee: "Co", amountMinor: 1 }))).toBeNull();
    expect(findBillMatch([bill()], input({ payee: "  A  ", amountMinor: 1 }))).toBeNull();
  });

  it("still matches by amount when the payee is too short to count", () => {
    const match = findBillMatch([bill()], input({ payee: "A", amountMinor: 12000 }));
    expect(match?.transaction.payee).toBe("Con Edison");
  });
});

describe("saveQuickLog goalId (paid from goal)", () => {
  const seedGoalAccountAndCategory = async (goalId: string, accountId: string) => {
    const repos = createRepositories(getDemoDb());
    await repos.accounts.put(mkAccount({ id: accountId, name: "Checking", currency: "USD" }));
    await repos.categories.put(mkCategory({ id: "ql-cat", name: "Food", kind: "expense" }));
    await repos.goals.put(mkGoal({ id: goalId, name: "LA trip float" }));
  };

  const expenseInput = (overrides: Partial<Parameters<typeof saveQuickLog>[1]> = {}) => ({
    type: "Expense" as const,
    amountMinor: 57000,
    accountId: "ql-acct",
    categoryId: "ql-cat" as string | null,
    payee: "Airline",
    date: "2026-10-15" as DateOnly,
    ...overrides,
  });

  it("stamps goalId on the created Expense and the stored row carries it", async () => {
    setDemoMode(true);
    try {
      await seedGoalAccountAndCategory("g-la", "ql-acct");
      const repos = createRepositories(getDemoDb());
      const { transaction } = await saveQuickLog(repos, expenseInput({ goalId: "g-la" }));

      expect(transaction.goalId).toBe("g-la");
      expect(transaction.type).toBe("Expense");
      expect(transaction.status).toBe("Cleared");

      const rows = await repos.transactions.getAll();
      expect(rows).toHaveLength(1);
      const row = rows[0] as NonNullable<typeof rows[number]>;
      expect(row.goalId).toBe("g-la");    } finally {
      setDemoMode(false);
    }
  });

  it("leaves goalId unset when not provided", async () => {
    setDemoMode(true);
    try {
      await seedGoalAccountAndCategory("g-la", "ql-acct");
      const repos = createRepositories(getDemoDb());
      const { transaction } = await saveQuickLog(repos, expenseInput());
      expect(transaction.goalId).toBeUndefined();
    } finally {
      setDemoMode(false);
    }
  });

  it("throws a clear error when goalId is passed for a Transfer or Income", async () => {
    setDemoMode(true);
    try {
      await seedGoalAccountAndCategory("g-la", "ql-acct");
      const repos = createRepositories(getDemoDb());
      await repos.accounts.put(mkAccount({ id: "ql-dest", name: "Savings" }));

      await expect(
        saveQuickLog(
          repos,
          expenseInput({
            type: "Transfer",
            toAccountId: "ql-dest",
            categoryId: null,
            goalId: "g-la",
          }),
        ),
      ).rejects.toThrow(/goalId is only supported for Expense entries/);

      await expect(
        saveQuickLog(repos, expenseInput({ type: "Income", goalId: "g-la" })),
      ).rejects.toThrow(/goalId is only supported for Expense entries/);

      // Nothing persisted through failed writes.
      expect(await repos.transactions.count()).toBe(0);
    } finally {
      setDemoMode(false);
    }
  });

  it("throws a clear error when the goal id does not exist", async () => {
    setDemoMode(true);
    try {
      await seedGoalAccountAndCategory("g-la", "ql-acct");
      const repos = createRepositories(getDemoDb());
      await expect(
        saveQuickLog(repos, expenseInput({ goalId: "g-missing" })),
      ).rejects.toThrow(/unknown goalId "g-missing"/);
      expect(await repos.transactions.count()).toBe(0);
    } finally {
      setDemoMode(false);
    }
  });

  it("throws a clear error when goalId is combined with settleScheduledId", async () => {
    setDemoMode(true);
    try {
      await seedGoalAccountAndCategory("g-la", "ql-acct");
      const repos = createRepositories(getDemoDb());
      await repos.transactions.put(
        mkTransaction({
          id: "ql-bill",
          status: "Scheduled",
          recurringRuleId: "rule-1",
          amount: 57000,
          accountId: "ql-acct",
          payee: "Airline",
        }),
      );
      await expect(
        saveQuickLog(
          repos,
          expenseInput({ goalId: "g-la", settleScheduledId: "ql-bill" }),
        ),
      ).rejects.toThrow(/goalId cannot be used when settling a scheduled bill/);
    } finally {
      setDemoMode(false);
    }
  });
});

describe("paid-from-goal engine wiring", () => {
  it("a goal-tagged Expense reduces earmarkedInSpendable for that goal", () => {
    const checking = mkAccount({ id: "chk", name: "Checking" });
    const accounts = ACCTS([checking]);
    // Self-transfer earmark of 570.00 into the goal, then 120.00 spent from it.
    const earmarkTx = mkTransaction({
      type: "Transfer",
      amount: 57000,
      accountId: "chk",
      transferToAccountId: "chk",
      categoryId: null,
      date: "2026-10-14",
      status: "Cleared",
      goalId: "g-la",
    });
    const goalSpendTx = mkTransaction({
      type: "Expense",
      amount: 12000,
      accountId: "chk",
      date: "2026-10-15",
      status: "Cleared",
      goalId: "g-la",
    });
    expect(earmarkedInSpendable("g-la", [earmarkTx], accounts)).toBe(57000);
    expect(earmarkedInSpendable("g-la", [earmarkTx, goalSpendTx], accounts)).toBe(45000);
    // An expense without the goal tag does not touch the earmark.
    const untagged = mkTransaction({
      type: "Expense",
      amount: 12000,
      accountId: "chk",
      date: "2026-10-15",
      status: "Cleared",
    });
    expect(earmarkedInSpendable("g-la", [earmarkTx, untagged], accounts)).toBe(57000);
  });

  it("a goal-tagged Expense is excluded from computeTodaySpending", () => {
    const goalExpense = mkTransaction({
      type: "Expense",
      amount: 12000,
      accountId: "chk",
      date: "2026-10-15",
      status: "Cleared",
      goalId: "g-la",
    });
    const plainExpense = mkTransaction({
      type: "Expense",
      amount: 3400,
      accountId: "chk",
      date: "2026-10-15",
      status: "Cleared",
    });
    const toBase = (t: Transaction) => t.amount;
    // Left today is unaffected by the goal-tagged spend: it does not count.
    expect(computeTodaySpending([goalExpense, plainExpense], "2026-10-15", toBase)).toBe(3400);
    expect(computeTodaySpending([goalExpense], "2026-10-15", toBase)).toBe(0);
  });
});

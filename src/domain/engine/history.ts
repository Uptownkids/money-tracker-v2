/**
 * Spending history (Phase B3): where the money went, from the ledger.
 *
 * - Only Expenses count as spending; Refunds reduce their category.
 *   Income and Transfers never appear.
 * - History-only rows (dated before an account's tracking start) are
 *   included here — they just don't move balances.
 * - Business-tagged transactions can be excluded via the filter.
 * - Every total carries its transaction ids for drill-down.
 */
import type { DateOnly } from "../dates/dateOnly.js";
import { yearOf, monthOf } from "../dates/dateOnly.js";
import type { Category } from "../entities/category.js";
import { transferCategoryIds } from "../entities/category.js";
import type { RecurringRule, Frequency } from "../entities/recurringRule.js";
import type { Transaction } from "../entities/transaction.js";
import type { MinorUnits } from "../money/money.js";
import { merchantKey } from "../import/payeeClean.js";

export interface HistoryOptions {
  /** False = hide business-tagged transactions. */
  includeBusiness: boolean;
}

export interface CategoryTotal {
  categoryId: string | null;
  name: string;
  total: MinorUnits;
  transactionIds: string[];
}

export interface MerchantTotal {
  merchantKey: string;
  name: string;
  total: MinorUnits;
  transactionIds: string[];
}

export interface MonthHistory {
  /** "2026-10" */
  month: string;
  total: MinorUnits;
  byCategory: CategoryTotal[];
  byMerchant: MerchantTotal[];
  /** Spending on Bills/Subscriptions (tagged with a rule). */
  bills: MinorUnits;
  everythingElse: MinorUnits;
  transactionIds: string[];
  billTransactionIds: string[];
}

export interface YearHistory {
  /** "2026" */
  year: string;
  total: MinorUnits;
  months: MonthHistory[];
  byCategory: CategoryTotal[];
  transactionIds: string[];
}

export interface YearOverYear {
  categoryId: string | null;
  name: string;
  thisYear: MinorUnits;
  lastYear: MinorUnits;
  delta: MinorUnits;
}

export interface SubscriptionSummary {
  ruleId: string;
  name: string;
  active: boolean;
  monthlyCost: MinorUnits;
  yearlyCost: MinorUnits;
  totalSpent: MinorUnits;
  chargeCount: number;
  since: DateOnly | null;
  transactionIds: string[];
}

export interface SpendingHistory {
  years: YearHistory[];
  yoy: YearOverYear[];
  subscriptions: SubscriptionSummary[];
}

/** Signed contribution of a transaction to spending. */
function spendingDelta(t: Transaction): MinorUnits {
  if (t.type === "Expense") return t.amount;
  if (t.type === "Refund") return -t.amount as MinorUnits;
  return 0;
}

function isSpending(
  t: Transaction,
  opts: HistoryOptions,
  transferCats: ReadonlySet<string> = new Set<string>(),
): boolean {
  if (t.type !== "Expense" && t.type !== "Refund") return false;
  // Transfers are never spending — including Expenses filed under a
  // Transfer category.
  if (t.type === "Expense" && t.categoryId != null && transferCats.has(t.categoryId)) return false;
  if (t.status === "Scheduled") return false; // projections aren't spending
  if (!opts.includeBusiness && t.tags.includes("business")) return false;
  return true;
}

function monthKey(d: DateOnly): string {
  return `${yearOf(d)}-${String(monthOf(d)).padStart(2, "0")}`;
}

export function buildSpendingHistory(
  transactions: readonly Transaction[],
  rules: readonly RecurringRule[],
  categories: readonly Category[],
  opts: HistoryOptions,
  today: DateOnly,
): SpendingHistory {
  const transferCats = transferCategoryIds(categories);
  const spending = transactions.filter((t) => isSpending(t, opts, transferCats));
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const isBill = (t: Transaction): boolean => {
    const rule = t.recurringRuleId ? ruleById.get(t.recurringRuleId) : undefined;
    return rule?.kind === "Bill" || rule?.kind === "Subscription";
  };

  // Group by year, then month.
  const byYear = new Map<string, Transaction[]>();
  for (const t of spending) {
    const y = String(yearOf(t.date));
    const list = byYear.get(y) ?? [];
    list.push(t);
    byYear.set(y, list);
  }

  const years: YearHistory[] = [...byYear.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([year, txs]) => buildYear(year, txs, catName, isBill));

  const thisYear = String(yearOf(today));
  const lastYear = String(yearOf(today) - 1);
  const yoy = buildYoy(
    byYear.get(thisYear) ?? [],
    byYear.get(lastYear) ?? [],
    catName,
  );

  const subscriptions = buildSubscriptions(spending, rules);

  return { years, yoy, subscriptions };
}

function buildYear(
  year: string,
  txs: Transaction[],
  catName: Map<string, string>,
  isBill: (t: Transaction) => boolean,
): YearHistory {
  const byMonth = new Map<string, Transaction[]>();
  for (const t of txs) {
    const m = monthKey(t.date);
    const list = byMonth.get(m) ?? [];
    list.push(t);
    byMonth.set(m, list);
  }
  const months: MonthHistory[] = [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([month, mtxs]) => {
      let bills = 0;
      let total = 0;
      const billIds: string[] = [];
      for (const t of mtxs) {
        const d = spendingDelta(t);
        total += d;
        if (isBill(t)) {
          bills += d;
          billIds.push(t.id);
        }
      }
      return {
        month,
        total: total as MinorUnits,
        byCategory: groupByCategory(mtxs, catName),
        byMerchant: groupByMerchant(mtxs),
        bills: bills as MinorUnits,
        everythingElse: (total - bills) as MinorUnits,
        transactionIds: mtxs.map((t) => t.id),
        billTransactionIds: billIds,
      };
    });

  let total = 0;
  for (const t of txs) total += spendingDelta(t);
  return {
    year,
    total: total as MinorUnits,
    months,
    byCategory: groupByCategory(txs, catName),
    transactionIds: txs.map((t) => t.id),
  };
}

function groupByCategory(txs: Transaction[], catName: Map<string, string>): CategoryTotal[] {
  const groups = new Map<string | null, { total: number; ids: string[] }>();
  for (const t of txs) {
    const key = t.categoryId;
    const g = groups.get(key) ?? { total: 0, ids: [] };
    g.total += spendingDelta(t);
    g.ids.push(t.id);
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([categoryId, g]) => ({
      categoryId,
      name: categoryId ? (catName.get(categoryId) ?? "Unknown") : "Uncategorized",
      total: g.total as MinorUnits,
      transactionIds: g.ids,
    }))
    .sort((a, b) => b.total - a.total);
}

function groupByMerchant(txs: Transaction[]): MerchantTotal[] {
  const groups = new Map<string, { name: string; total: number; ids: string[]; votes: Map<string, number> }>();
  for (const t of txs) {
    const key = merchantKey(t.payee) || t.payee.toUpperCase();
    let g = groups.get(key);
    if (!g) {
      g = { name: t.payee, total: 0, ids: [], votes: new Map() };
      groups.set(key, g);
    }
    g.total += spendingDelta(t);
    g.ids.push(t.id);
    g.votes.set(t.payee, (g.votes.get(t.payee) ?? 0) + 1);
  }
  return [...groups.entries()]
    .map(([merchantKey, g]) => {
      let name = g.name;
      let best = 0;
      for (const [payee, n] of g.votes) {
        if (n > best) {
          best = n;
          name = payee;
        }
      }
      return { merchantKey, name, total: g.total as MinorUnits, transactionIds: g.ids };
    })
    .sort((a, b) => b.total - a.total);
}

function buildYoy(
  thisYearTx: Transaction[],
  lastYearTx: Transaction[],
  catName: Map<string, string>,
): YearOverYear[] {
  const sum = (txs: Transaction[]): Map<string | null, number> => {
    const m = new Map<string | null, number>();
    for (const t of txs) {
      m.set(t.categoryId, (m.get(t.categoryId) ?? 0) + spendingDelta(t));
    }
    return m;
  };
  const thisMap = sum(thisYearTx);
  const lastMap = sum(lastYearTx);
  const keys = new Set<string | null>([...thisMap.keys(), ...lastMap.keys()]);
  return [...keys]
    .map((categoryId) => {
      const thisYear = thisMap.get(categoryId) ?? 0;
      const lastYear = lastMap.get(categoryId) ?? 0;
      return {
        categoryId,
        name: categoryId ? (catName.get(categoryId) ?? "Unknown") : "Uncategorized",
        thisYear: thisYear as MinorUnits,
        lastYear: lastYear as MinorUnits,
        delta: (thisYear - lastYear) as MinorUnits,
      };
    })
    .sort((a, b) => b.thisYear - a.thisYear);
}

/** Normalize a rule's amount to a monthly cost. */
export function monthlyCostFor(rule: Pick<RecurringRule, "amount" | "frequency">): MinorUnits {
  const a = rule.amount;
  switch (rule.frequency as Frequency) {
    case "weekly":
      return Math.round((a * 52) / 12) as MinorUnits;
    case "biweekly":
      return Math.round((a * 26) / 12) as MinorUnits;
    case "semi-monthly":
      return (a * 2) as MinorUnits;
    case "monthly":
      return a;
    case "annual":
      return Math.round(a / 12) as MinorUnits;
    case "custom":
      return a; // unknown cadence: report as-is
  }
}

function buildSubscriptions(
  spending: Transaction[],
  rules: readonly RecurringRule[],
): SubscriptionSummary[] {
  const byRule = new Map<string, Transaction[]>();
  for (const t of spending) {
    if (!t.recurringRuleId) continue;
    const list = byRule.get(t.recurringRuleId) ?? [];
    list.push(t);
    byRule.set(t.recurringRuleId, list);
  }
  const out: SubscriptionSummary[] = [];
  for (const rule of rules) {
    if (rule.kind !== "Subscription") continue;
    const txs = (byRule.get(rule.id) ?? []).filter((t) => t.status === "Cleared");
    let total = 0;
    for (const t of txs) total += spendingDelta(t);
    const dates = txs.map((t) => t.date).sort();
    const monthly = monthlyCostFor(rule);
    out.push({
      ruleId: rule.id,
      name: rule.name,
      active: rule.active,
      monthlyCost: monthly,
      yearlyCost: (monthly * 12) as MinorUnits,
      totalSpent: total as MinorUnits,
      chargeCount: txs.length,
      since: dates.length > 0 ? dates[0]! : null,
      transactionIds: txs.map((t) => t.id),
    });
  }
  return out.sort((a, b) => b.monthlyCost - a.monthlyCost);
}

/**
 * Spending history (Phase B3): where the money went, by year and month.
 * Breakdowns by category, by merchant, and bills vs everything else, plus
 * year-over-year comparison and a subscriptions summary. Every total
 * drills down to its transactions. Figures come from the ledger.
 */
import { useEffect, useMemo, useState } from "react";
import { getActiveDb } from "../data/db.js";
import { createRepositories } from "../data/repositories/index.js";
import type { Transaction } from "../domain/entities/transaction.js";
import {
  buildSpendingHistory,
  type CategoryTotal,
  type MerchantTotal,
  type SpendingHistory,
} from "../domain/engine/history.js";
import { todayLocal } from "../domain/dates/dateOnly.js";
import { formatMoney } from "../app/format.js";

function repos() {
  return createRepositories(getActiveDb());
}

const sectionCls =
  "rounded-3xl border border-stone-200/70 dark:border-stone-700 bg-white dark:bg-stone-900 px-5 py-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]";
const headingCls =
  "text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400";
const rowCls =
  "flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left transition-colors hover:bg-stone-50 dark:hover:bg-stone-800";

function monthLabel(m: string): string {
  const [y, mo] = m.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(mo) - 1]} ${y}`;
}

export function History() {
  const [history, setHistory] = useState<SpendingHistory | null>(null);
  const [txById, setTxById] = useState<Map<string, Transaction>>(new Map());
  const [year, setYear] = useState<string | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [view, setView] = useState<"category" | "merchant">("category");
  const [includeBusiness, setIncludeBusiness] = useState(true);
  const [drill, setDrill] = useState<{ title: string; ids: string[] } | null>(null);
  const [currency, setCurrency] = useState("USD");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = repos();
      const [txs, rules, cats, settings] = await Promise.all([
        r.transactions.getAll(),
        r.recurringRules.getAll(),
        r.categories.getAll(),
        r.settings.get(),
      ]);
      if (cancelled) return;
      setCurrency(settings?.baseCurrency ?? "USD");
      setTxById(new Map(txs.map((t) => [t.id, t])));
      setHistory(buildSpendingHistory(txs, rules, cats, { includeBusiness }, todayLocal()));
    })();
    return () => {
      cancelled = true;
    };
  }, [includeBusiness]);

  const years = useMemo(() => history?.years ?? [], [history]);
  useEffect(() => {
    if (!year && years.length > 0) setYear(years[0]!.year);
  }, [years, year]);

  const yearData = years.find((y) => y.year === year);
  const monthData = month ? yearData?.months.find((m) => m.month === month) : undefined;
  const scopeTxIds = monthData?.transactionIds ?? yearData?.transactionIds ?? [];
  const scopeTotal = monthData?.total ?? yearData?.total ?? 0;
  const scopeByCategory: CategoryTotal[] = monthData?.byCategory ?? yearData?.byCategory ?? [];
  const scopeByMerchant: MerchantTotal[] = monthData?.byMerchant ?? [];

  if (drill) {
    const txs = drill.ids
      .map((id) => txById.get(id))
      .filter((t): t is Transaction => !!t)
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    return (
      <div className="space-y-4 pb-24">
        <button type="button" onClick={() => setDrill(null)} className={rowCls}>
          <span className="text-sm font-medium text-stone-900 dark:text-stone-100">← Back</span>
        </button>
        <section className={sectionCls}>
          <p className={headingCls}>{drill.title}</p>
          <ul className="mt-2 divide-y divide-stone-100 dark:divide-stone-800">
            {txs.map((t) => (
              <li key={t.id} className="flex items-baseline justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm text-stone-900 dark:text-stone-100">
                    {t.payee}
                  </span>
                  <span className="text-xs text-stone-500 dark:text-stone-400">
                    {t.date}
                    {t.tags.includes("business") ? " · Business" : ""}
                  </span>
                </span>
                <span className="shrink-0 text-sm font-medium text-stone-900 dark:text-stone-100">
                  {formatMoney(t.type === "Refund" ? -t.amount : t.amount, currency)}
                </span>
              </li>
            ))}
          </ul>
          {txs.length === 0 && (
            <p className="mt-2 text-sm text-stone-500">No transactions.</p>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-stone-900 dark:text-stone-100">History</h1>
        <label className="flex items-center gap-2 text-sm text-stone-600 dark:text-stone-300">
          <input
            type="checkbox"
            checked={includeBusiness}
            onChange={(e) => setIncludeBusiness(e.target.checked)}
          />
          Business
        </label>
      </div>

      {years.length === 0 && (
        <section className={sectionCls}>
          <p className="text-sm text-stone-600 dark:text-stone-300">
            No spending yet. Import your bank history to see where your money went.
          </p>
        </section>
      )}

      {years.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto">
          {years.map((y) => (
            <button
              key={y.year}
              type="button"
              onClick={() => {
                setYear(y.year);
                setMonth(null);
              }}
              className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                y.year === year
                  ? "bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900"
                  : "border border-stone-200 text-stone-600 dark:border-stone-700 dark:text-stone-300"
              }`}
            >
              {y.year}
            </button>
          ))}
        </div>
      )}

      {yearData && (
        <section className={sectionCls}>
          <div className="flex items-baseline justify-between">
            <p className={headingCls}>{month ? monthLabel(month) : yearData.year}</p>
            <button
              type="button"
              className="text-sm font-semibold text-stone-900 dark:text-stone-100"
              onClick={() =>
                setDrill({
                  title: month ? `${monthLabel(month)} spending` : `${yearData.year} spending`,
                  ids: scopeTxIds,
                })
              }
            >
              {formatMoney(scopeTotal, currency)}
            </button>
          </div>

          <div className="mt-2 flex gap-1.5 overflow-x-auto">
            <button
              type="button"
              onClick={() => setMonth(null)}
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${
                month === null
                  ? "bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900"
                  : "border border-stone-200 text-stone-600 dark:border-stone-700 dark:text-stone-300"
              }`}
            >
              All year
            </button>
            {yearData.months.map((m) => (
              <button
                key={m.month}
                type="button"
                onClick={() => setMonth(m.month)}
                className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${
                  month === m.month
                    ? "bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900"
                    : "border border-stone-200 text-stone-600 dark:border-stone-700 dark:text-stone-300"
                }`}
              >
                {monthLabel(m.month)}
              </button>
            ))}
          </div>

          {(monthData?.bills ?? 0) > 0 || (yearData && !month) ? (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                className="rounded-2xl bg-stone-100 p-3 text-left dark:bg-stone-800"
                onClick={() => {
                  const ids = monthData
                    ? monthData.billTransactionIds
                    : yearData.months.flatMap((m) => m.billTransactionIds);
                  setDrill({ title: "Bills & subscriptions", ids });
                }}
              >
                <span className="block text-[11px] uppercase tracking-wide text-stone-500 dark:text-stone-400">
                  Bills & subscriptions
                </span>
                <span className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                  {formatMoney(
                    monthData ? monthData.bills : yearData.months.reduce((s, m) => s + m.bills, 0),
                    "USD",
                  )}
                </span>
              </button>
              <div className="rounded-2xl bg-stone-100 p-3 dark:bg-stone-800">
                <span className="block text-[11px] uppercase tracking-wide text-stone-500 dark:text-stone-400">
                  Everything else
                </span>
                <span className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                  {formatMoney(
                    monthData
                      ? monthData.everythingElse
                      : yearData.months.reduce((s, m) => s + m.everythingElse, 0),
                    "USD",
                  )}
                </span>
              </div>
            </div>
          ) : null}

          <div className="mt-3 flex gap-1.5">
            {(["category", "merchant"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  view === v
                    ? "bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900"
                    : "border border-stone-200 text-stone-600 dark:border-stone-700 dark:text-stone-300"
                }`}
              >
                {v === "category" ? "By category" : "By merchant"}
              </button>
            ))}
          </div>

          <ul className="mt-1 divide-y divide-stone-100 dark:divide-stone-800">
            {(view === "category" ? scopeByCategory : scopeByMerchant).map((g) => (
              <li key={view === "category" ? (g as CategoryTotal).categoryId ?? "none" : (g as MerchantTotal).merchantKey}>
                <button
                  type="button"
                  className={rowCls}
                  onClick={() => setDrill({ title: g.name, ids: g.transactionIds })}
                >
                  <span className="truncate text-sm text-stone-900 dark:text-stone-100">{g.name}</span>
                  <span className="shrink-0 text-sm font-medium text-stone-900 dark:text-stone-100">
                    {formatMoney(g.total, currency)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {history && history.yoy.length > 0 && (
        <section className={sectionCls}>
          <p className={headingCls}>Year over year</p>
          <ul className="mt-2 divide-y divide-stone-100 dark:divide-stone-800">
            {history.yoy.slice(0, 8).map((y) => (
              <li key={y.categoryId ?? "none"} className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm text-stone-900 dark:text-stone-100">
                    {y.name}
                  </span>
                  <span className="text-xs text-stone-500 dark:text-stone-400">
                    {formatMoney(y.lastYear, currency)} → {formatMoney(y.thisYear, currency)}
                  </span>
                </span>
                <span
                  className={`shrink-0 text-sm font-medium ${
                    y.delta > 0
                      ? "text-red-700 dark:text-red-300"
                      : "text-emerald-700 dark:text-emerald-300"
                  }`}
                >
                  {y.delta > 0 ? "+" : ""}
                  {formatMoney(y.delta, currency)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {history && history.subscriptions.length > 0 && (
        <section className={sectionCls}>
          <p className={headingCls}>Subscriptions</p>
          <ul className="mt-2 divide-y divide-stone-100 dark:divide-stone-800">
            {history.subscriptions.map((s) => (
              <li key={s.ruleId}>
                <button
                  type="button"
                  className={rowCls}
                  onClick={() => setDrill({ title: `${s.name} charges`, ids: s.transactionIds })}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-stone-900 dark:text-stone-100">
                      {s.name}
                      {!s.active && (
                        <span className="ml-1 text-xs text-stone-400">(ended)</span>
                      )}
                    </span>
                    <span className="text-xs text-stone-500 dark:text-stone-400">
                      {formatMoney(s.monthlyCost, currency)}/mo · {formatMoney(s.yearlyCost, currency)}/yr
                      {s.since ? ` · since ${s.since.slice(0, 7)}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-sm font-medium text-stone-900 dark:text-stone-100">
                      {formatMoney(s.totalSpent, currency)}
                    </span>
                    <span className="block text-xs text-stone-500 dark:text-stone-400">total</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

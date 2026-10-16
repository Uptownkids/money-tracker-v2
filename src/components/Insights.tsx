/**
 * Insights: read-only aggregates over the user's money.
 * Cash flow, balances and net worth, runway, charts, goals, IOUs,
 * and subscriptions. Pure engine math lives in
 * src/domain/engine/insights.ts; this component only loads data and
 * renders. Every section has an empty state; nothing here writes.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { createRepositories } from "../data/repositories/index.js";
import { getActiveDb } from "../data/db.js";
import { formatMoney, formatWhole } from "../app/format.js";
import { makeConverter } from "../app/dashboard.js";
import { FxRateMemory } from "../domain/money/fx.js";
import { decimalsOf } from "../domain/money/currency.js";
import type { MinorUnits } from "../domain/money/money.js";
import type { DateOnly } from "../domain/dates/dateOnly.js";
import type { Account } from "../domain/entities/account.js";
import type { Category } from "../domain/entities/category.js";
import type { Goal } from "../domain/entities/goal.js";
import type { RecurringOverride, RecurringRule } from "../domain/entities/recurringRule.js";
import type { DailySnapshot } from "../domain/entities/settings.js";
import type { Split } from "../domain/entities/split.js";
import type { Transaction } from "../domain/entities/transaction.js";
import { affectsBalance } from "../domain/entities/transaction.js";
import { deriveBalances, netWorth } from "../domain/engine/balances.js";
import { defaultTransactionToBase } from "../domain/engine/safeToSpend.js";
import {
  goalProgress,
  incomeVsOutflow,
  monthlyCashFlow,
  outstandingIous,
  runway,
  spendingByCategory,
  spendingHistory,
  subscriptionTotals,
} from "../domain/engine/insights.js";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function shortMonth(key: string): string {
  const m = Number(key.slice(5, 7));
  return `${MONTHS[m - 1]} ${key.slice(2, 4)}`;
}

/**
 * X-axis labels for the 12-month income-vs-outflow trend, oldest first.
 * Short month names ("Nov"); the 2-digit year appears only on the first
 * label and where the year changes ("Nov ’25", "Jan ’26"), so ~6 labels
 * fit a 375px phone screen without overlapping.
 */
export function trendTickLabels(monthKeys: string[]): string[] {
  return monthKeys.map((k, i) => {
    const m = Number(k.slice(5, 7));
    const name = MONTHS[m - 1] ?? "";
    const showYear = i === 0 || k.slice(0, 4) !== monthKeys[i - 1]!.slice(0, 4);
    return showYear ? `${name} ’${k.slice(2, 4)}` : name;
  });
}

/** True while the <html> element carries the dark class. Reactive. */
function useDarkMode(): boolean {
  const [dark, setDark] = useState(
    () =>
      typeof document !== "undefined" &&
      document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const el = document.documentElement;
    const update = (): void => setDark(el.classList.contains("dark"));
    update();
    const obs = new MutationObserver(update);
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

interface ChartPalette {
  barStrong: string;
  barSoft: string;
  barFaint: string;
  grid: string;
  tick: string;
}

/** Recharts needs explicit colors; these mirror the Tailwind stone scale. */
function chartPalette(dark: boolean): ChartPalette {
  return dark
    ? {
        barStrong: "#d6d3d1", // stone-300
        barSoft: "#78716c", // stone-500
        barFaint: "#57534e", // stone-600
        grid: "#292524", // stone-800
        tick: "#a8a29e", // stone-400
      }
    : {
        barStrong: "#44403c", // stone-700
        barSoft: "#a8a29e", // stone-400
        barFaint: "#d6d3d1", // stone-300
        grid: "#e7e5e4", // stone-200
        tick: "#57534e", // stone-600
      };
}

function shortDate(d: DateOnly): string {
  return `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
}

function Card({
  title,
  children,
  hint,
}: {
  title: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <section className="rounded-3xl border border-stone-200/70 bg-white px-5 py-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:border-stone-800 dark:bg-stone-900">
      <h2 className="font-display text-lg text-stone-900 dark:text-stone-100">{title}</h2>
      {hint ? (
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{hint}</p>
      ) : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-stone-500 dark:text-stone-400">{children}</p>;
}

function ChartTip({
  active,
  payload,
  label,
  currency,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number | string; color?: string }[];
  label?: string;
  currency: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs text-stone-900 shadow-lg dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100">
      {label ? <p className="mb-1 font-medium">{label}</p> : null}
      {payload.map((p, i) => (
        <p key={i}>
          {p.name}:{" "}
          {typeof p.value === "number"
            ? formatMoney(Math.round(p.value * 10 ** decimalsOf(currency)), currency)
            : p.value}
        </p>
      ))}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-2xl bg-stone-50 px-4 py-3 dark:bg-stone-800">
      <p className="text-xs text-stone-500 dark:text-stone-400">{label}</p>
      <p className="mt-1 font-display text-2xl text-stone-900 dark:text-stone-100">{value}</p>
      {sub ? <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{sub}</p> : null}
    </div>
  );
}

export function Insights() {
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [splits, setSplits] = useState<Split[]>([]);
  const [rules, setRules] = useState<RecurringRule[]>([]);
  const [overrides, setOverrides] = useState<RecurringOverride[]>([]);
  const [snapshots, setSnapshots] = useState<DailySnapshot[]>([]);
  const [baseCurrency, setBaseCurrency] = useState("USD");
  const [fxMemory] = useState(() => new FxRateMemory());
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const dark = useDarkMode();

  const load = useCallback(async () => {
    const repos = createRepositories(getActiveDb());
    const [accts, txs, cats, gs, sps, rs, ovs, snaps, settings] = await Promise.all([
      repos.accounts.getAll(),
      repos.transactions.getAll(),
      repos.categories.getAll(),
      repos.goals.getAll(),
      repos.splits.getAll(),
      repos.recurringRules.getAll(),
      repos.recurringOverrides.getAll(),
      repos.dailySnapshots.getAll(),
      repos.settings.get(),
    ]);
    setAccounts(accts.filter((a) => !a.archived));
    setTransactions(txs);
    setCategories(cats.filter((c) => !c.archived));
    setGoals(gs);
    setSplits(sps);
    setRules(rs);
    setOverrides(ovs);
    setSnapshots(snaps);
    const currency = settings?.baseCurrency ?? "USD";
    setBaseCurrency(currency);
    const rates = settings?.lastUsedFxRates;
    if (rates) {
      for (const [pair, rate] of Object.entries(rates)) {
        const [from, to] = pair.split("->");
        if (from && to) fxMemory.setRate(from, to, rate);
      }
    }
    setLoading(false);
  }, [fxMemory]);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => {
    if (loading) return null;
    const today = new Date().toISOString().slice(0, 10) as DateOnly;
    const convertToBase = makeConverter(baseCurrency, fxMemory, () => {});
    const accountsById = new Map(accounts.map((a) => [a.id, a]));
    const accountCurrencyOf = (id: string): string =>
      accountsById.get(id)?.currency ?? baseCurrency;
    const toBase = defaultTransactionToBase(accountCurrencyOf, convertToBase);
    const balanceToBase = (balance: MinorUnits, account: Account): MinorUnits =>
      convertToBase(balance, account.currency, account);

    const balances = deriveBalances(accounts, transactions);
    const cash = monthlyCashFlow(transactions, month, toBase);
    const refundsInMonth = transactions
      .filter((t) => t.type === "Refund" && t.date.slice(0, 7) === month && affectsBalance(t))
      .reduce<MinorUnits>((acc, t) => acc + toBase(t), 0);

    return {
      today,
      cash,
      refundsInMonth,
      categories: spendingByCategory(transactions, month, categories, toBase),
      trend: incomeVsOutflow(transactions, month, 12, toBase),
      balances,
      worth: netWorth(balances),
      runway: runway(accounts, balances, transactions, today, toBase, balanceToBase),
      history: spendingHistory(snapshots, transactions, toBase, baseCurrency),
      goals: goalProgress(goals, transactions, toBase, new Map(accounts.map((a) => [a.id, a]))),
      ious: outstandingIous(splits, (amt, cur) => convertToBase(amt, cur)),
      subs: subscriptionTotals(rules, overrides, today),
    };
  }, [loading, accounts, transactions, categories, goals, splits, rules, overrides, snapshots, baseCurrency, fxMemory, month]);

  if (loading || !stats) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-stone-300 border-t-stone-800 dark:border-stone-700 dark:border-t-stone-200" />
      </div>
    );
  }

  const div = 10 ** decimalsOf(baseCurrency);
  const tickFmt = (v: number): string => formatWhole(Math.round(v * div), baseCurrency);
  const hasAnyTx = transactions.some((t) => affectsBalance(t));
  const palette = chartPalette(dark);
  const tickStyle = { fontSize: 11, fill: palette.tick };
  const trendLabels = trendTickLabels(stats.trend.map((b) => b.month));
  // Daily chart: keep ~6 x labels on a 375px phone.
  const dailyInterval = Math.max(0, Math.ceil(stats.history.days.length / 6) - 1);

  return (
    <div className="flex flex-col gap-4 pb-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl text-stone-900 dark:text-stone-100">Insights</h1>
        <input
          type="month"
          value={month}
          max={new Date().toISOString().slice(0, 7)}
          onChange={(e) => setMonth(e.target.value)}
          aria-label="Pick a month"
          className="rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
        />
      </div>

      {!hasAnyTx ? (
        <Card title="Welcome to Insights">
          <Empty>
            Nothing to show yet. Log your first transaction and this page will
            start telling you where the money goes.
          </Empty>
        </Card>
      ) : (
        <>
          <Card
            title="Cash flow"
            hint="Expenses are net of refunds. Refunds lower spending, they are never income."
          >
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Income" value={formatMoney(stats.cash.income, baseCurrency)} />
              <Stat
                label="Expenses"
                value={formatMoney(stats.cash.expenses, baseCurrency)}
                sub={
                  stats.refundsInMonth > 0
                    ? `${formatMoney(stats.refundsInMonth, baseCurrency)} came back as refunds`
                    : undefined
                }
              />
              <Stat label="Net" value={formatMoney(stats.cash.net, baseCurrency)} />
            </div>
          </Card>

          <Card title="Balances">
            {accounts.length === 0 ? (
              <Empty>No accounts yet.</Empty>
            ) : (
              <div className="flex flex-col gap-2">
                {accounts.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center justify-between rounded-2xl bg-stone-50 px-4 py-2.5 dark:bg-stone-800"
                  >
                    <span className="text-sm text-stone-900 dark:text-stone-100">{a.name}</span>
                    <span className="text-sm font-medium text-stone-900 dark:text-stone-100">
                      {formatMoney(stats.balances[a.id] ?? 0, baseCurrency)}
                    </span>
                  </div>
                ))}
                <div className="flex items-center justify-between px-4 pt-2">
                  <span className="text-sm font-medium text-stone-600 dark:text-stone-400">
                    Net worth
                  </span>
                  <span className="font-display text-xl text-stone-900 dark:text-stone-100">
                    {formatMoney(stats.worth, baseCurrency)}
                  </span>
                </div>
              </div>
            )}
          </Card>

          <Card title="Runway">
            {stats.runway.days === null ? (
              <Empty>
                No spending in the last 30 days yet, so there is no runway
                number to show.
              </Empty>
            ) : (
              <p className="text-sm text-stone-600 dark:text-stone-400">
                <span
                  className="font-display text-3xl text-stone-900 dark:text-stone-100"
                  title="Runway = liquid balance ÷ average daily spending (trailing 30 days). Liquid = balances in spendable accounts only. Average daily spending = expenses minus refunds over the last 30 days, divided by 30."
                >
                  {stats.runway.days} days
                </span>{" "}
                <span className="text-xs text-stone-500 dark:text-stone-400">
                  (hover the number for the exact formula)
                </span>
              </p>
            )}
          </Card>

          <Card title="Where the money went" hint={`Spending by category in ${shortMonth(month)}.`}>
            {stats.categories.length === 0 ? (
              <Empty>No spending this month yet.</Empty>
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={stats.categories.map((c) => ({
                      name: c.name,
                      amount: c.amount / div,
                    }))}
                    layout="vertical"
                    margin={{ left: 8, right: 16 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke={palette.grid} horizontal={false} />
                    <XAxis type="number" tickFormatter={tickFmt} tick={tickStyle} />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={110}
                      tick={tickStyle}
                    />
                    <Tooltip content={<ChartTip currency={baseCurrency} />} />
                    <Bar dataKey="amount" fill={palette.barStrong} radius={[0, 6, 6, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <Card title="Income vs outflow" hint="The last 12 months, ending this month.">
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={stats.trend.map((b, i) => ({
                    label: trendLabels[i],
                    income: b.income / div,
                    outflow: b.outflow / div,
                  }))}
                  margin={{ bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={palette.grid} vertical={false} />
                  <XAxis dataKey="label" tick={tickStyle} interval={1} />
                  <YAxis tickFormatter={tickFmt} tick={tickStyle} width={56} />
                  <Tooltip content={<ChartTip currency={baseCurrency} />} />
                  <Legend wrapperStyle={{ fontSize: 12, color: palette.tick }} />
                  <Bar dataKey="income" name="Income" fill={palette.barStrong} radius={[4, 4, 0, 0]} />
                  <Bar dataKey="outflow" name="Outflow" fill={palette.barSoft} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card title="Daily numbers" hint="Start of day budget vs what you spent, from your saved daily snapshots.">
            {stats.history.days.length === 0 ? (
              <Empty>
                No daily numbers saved yet. They appear once your safe to spend
                is calculated.
              </Empty>
            ) : (
              <>
                <div className="mb-4 grid grid-cols-2 gap-3">
                  <Stat label="Days under budget" value={String(stats.history.under)} />
                  <Stat label="Days over budget" value={String(stats.history.over)} />
                </div>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={stats.history.days.map((d) => ({
                        label: shortDate(d.date),
                        budget: d.budget / div,
                        spent: d.spent / div,
                      }))}
                      margin={{ bottom: 4 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke={palette.grid} vertical={false} />
                      <XAxis dataKey="label" tick={tickStyle} interval={dailyInterval} />
                      <YAxis tickFormatter={tickFmt} tick={tickStyle} width={56} />
                      <Tooltip content={<ChartTip currency={baseCurrency} />} />
                      <Legend wrapperStyle={{ fontSize: 12, color: palette.tick }} />
                      <Bar dataKey="budget" name="Budget" fill={palette.barFaint} radius={[4, 4, 0, 0]} />
                      <Bar dataKey="spent" name="Spent" fill={palette.barStrong} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}
          </Card>

          <Card title="Goals">
            {stats.goals.length === 0 ? (
              <Empty>No goals yet. Set one and watch it grow.</Empty>
            ) : (
              <div className="flex flex-col gap-3">
                {stats.goals.map(({ goal, saved, pct }) => (
                  <div key={goal.id}>
                    <div className="mb-1 flex items-baseline justify-between">
                      <span className="text-sm font-medium text-stone-900 dark:text-stone-100">
                        {goal.name}
                        {goal.completed && (
                          <span className="ml-2 rounded-full bg-emerald-100 dark:bg-emerald-950 px-2 py-0.5 align-middle text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                            Completed
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-stone-500 dark:text-stone-400">
                        {formatMoney(saved, baseCurrency)} of {formatMoney(goal.targetAmount, baseCurrency)}
                      </span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-stone-100 dark:bg-stone-800">
                      <div
                        className="h-full rounded-full bg-stone-700 dark:bg-stone-300"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="IOUs">
            {stats.ious.owedToYou === 0 && stats.ious.youOwe === 0 ? (
              <Empty>No open IOUs. Nice.</Empty>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Stat
                  label="Owed to you"
                  value={formatMoney(stats.ious.owedToYou, baseCurrency)}
                />
                <Stat label="You owe" value={formatMoney(stats.ious.youOwe, baseCurrency)} />
              </div>
            )}
          </Card>

          <Card title="Subscriptions" hint="Yearly cost of active subscriptions, from your recurring rules.">
            {stats.subs.perYear === 0 ? (
              <Empty>No active subscriptions.</Empty>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Stat label="Per month" value={formatMoney(stats.subs.perMonth, baseCurrency)} />
                <Stat label="Per year" value={formatMoney(stats.subs.perYear, baseCurrency)} />
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

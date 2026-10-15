/**
 * Coming up: the 30-day outlook of bills and subscriptions — projected
 * occurrences merged with their Scheduled rows (the row wins), overdue
 * items first. Read-only; the parent places it on the Dashboard.
 */
import { useCallback, useEffect, useState } from "react";
import { createRepositories } from "../data/repositories/index.js";
import { getActiveDb } from "../data/db.js";
import { makeConverter } from "../app/dashboard.js";
import { FxRateMemory } from "../domain/money/fx.js";
import { buildUpcoming, type UpcomingItem } from "../domain/engine/upcoming.js";
import { formatMoney } from "../app/format.js";
import {
  dayOfMonth,
  monthOf,
  todayLocal,
  yearOf,
  type DateOnly,
} from "../domain/dates/dateOnly.js";
import type { RecurringOverride } from "../domain/entities/recurringRule.js";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** e.g. "Thu, Oct 22". UTC calendar fields only — never local time. */
function formatDay(d: DateOnly): string {
  const dt = new Date(Date.UTC(yearOf(d), monthOf(d) - 1, dayOfMonth(d)));
  return `${DAYS[dt.getUTCDay()]}, ${MONTHS[dt.getUTCMonth()]} ${dayOfMonth(d)}`;
}

function ItemRow({
  item,
  baseCurrency,
  onOpenItem,
}: {
  item: UpcomingItem;
  baseCurrency: string;
  onOpenItem: (item: UpcomingItem) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpenItem(item)}
      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-stone-50 dark:hover:bg-stone-800"
    >
      <span className="w-24 shrink-0">
        <span className="block text-sm font-medium text-stone-900 dark:text-stone-100">
          {formatDay(item.date)}
        </span>
        {item.overdue ? (
          <span className="mt-0.5 inline-block rounded-full border border-red-200/70 dark:border-red-800 bg-red-50 dark:bg-red-950 px-2 py-px text-[10px] font-semibold uppercase tracking-[0.08em] text-red-700 dark:text-red-300">
            Overdue
          </span>
        ) : (
          <span className="mt-0.5 block text-[11px] text-stone-400">
            {item.source === "scheduled" ? "Scheduled" : "Projected"}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-stone-900 dark:text-stone-100">
          {item.name}
        </span>
        {item.overdue && (
          <span className="block pt-0.5 text-[11px] text-stone-400">
            {item.source === "scheduled" ? "Scheduled" : "Projected"}
          </span>
        )}
      </span>
      <span className="shrink-0 text-sm font-semibold text-stone-900 dark:text-stone-100">
        {formatMoney(item.amount, baseCurrency)}
      </span>
    </button>
  );
}

export function Upcoming({ onOpenItem }: { onOpenItem: (item: UpcomingItem) => void }) {
  const [items, setItems] = useState<UpcomingItem[]>([]);
  const [baseCurrency, setBaseCurrency] = useState("USD");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const repos = createRepositories(getActiveDb());
    const [accounts, transactions, rules, overrides, settings] = await Promise.all([
      repos.accounts.getAll(),
      repos.transactions.getAll(),
      repos.recurringRules.active(),
      repos.recurringOverrides.getAll(),
      repos.settings.get(),
    ]);
    const today = todayLocal();
    const currency = settings?.baseCurrency ?? "USD";
    const fxMemory = new FxRateMemory();
    for (const [pair, rate] of Object.entries(settings?.lastUsedFxRates ?? {})) {
      const [from, to] = pair.split("->");
      if (from && to) fxMemory.setRate(from, to, rate);
    }
    // Missing rates pass through unconverted with a visible warning at
    // the dashboard level; here the amounts simply follow the converter.
    const convertToBase = makeConverter(currency, fxMemory, () => {});
    const accountsById = new Map(accounts.map((a) => [a.id, a]));
    const accountCurrencyOf = (id: string): string =>
      accountsById.get(id)?.currency ?? currency;
    const overridesByRule: Record<string, RecurringOverride[]> = {};
    for (const o of overrides) {
      (overridesByRule[o.ruleId] ??= []).push(o);
    }
    setItems(
      buildUpcoming({
        rules,
        overridesByRule,
        transactions,
        today,
        convertToBase,
        accountCurrencyOf,
      }),
    );
    setBaseCurrency(currency);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return null;

  return (
    <section className="rounded-3xl border border-stone-200/70 dark:border-stone-700 bg-white dark:bg-stone-900 px-2 py-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <p className="px-4 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400">
        Coming up
      </p>
      {items.length === 0 ? (
        <p className="px-4 pt-2 text-sm text-stone-600 dark:text-stone-400">
          Nothing due in the next 30 days.
        </p>
      ) : (
        <div className="divide-y divide-stone-100 dark:divide-stone-800">
          {items.map((item) => (
            <ItemRow key={item.key} item={item} baseCurrency={baseCurrency} onOpenItem={onOpenItem} />
          ))}
        </div>
      )}
    </section>
  );
}

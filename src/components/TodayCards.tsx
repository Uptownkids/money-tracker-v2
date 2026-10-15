/**
 * The top of the Today screen: two cards side by side.
 *
 * Left — Cash on Hand: light card, blue label. The base-currency total
 * across spendable accounts only (never savings, cards, or loans).
 * Subtitle names the next payday ("Payday today" on payday). Tapping
 * opens a per-account breakdown.
 *
 * Right — Safe to Spend Today: solid card, white text. The day's number
 * from the DailySnapshot (pinned at midnight). Subtitle: what's left
 * today and the daily number through payday. Tapping opens the
 * plain-English breakdown. State colors: green normal, amber when left
 * today drops under 20% of the day's number, red when overspent, dark
 * stone for the deficit state (short of covering everything).
 *
 * The cards stack vertically only on very narrow phones (< 380px).
 */
import { useState, type ReactNode } from "react";
import type { DashboardState } from "../app/dashboard.js";
import { formatMoney } from "../app/format.js";
import type { MinorUnits } from "../domain/money/money.js";

type HeroState = DashboardState["heroState"];

const SAFE_BG: Record<HeroState, string> = {
  normal: "bg-green-700",
  amber: "bg-amber-600",
  red: "bg-red-600",
  deficit: "bg-stone-900",
};

function formatPayday(date: string): string {
  const [, m, d] = date.split("-");
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[Number(m) - 1]} ${Number(d)}`;
}

function SheetShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div className="absolute bottom-0 inset-x-0 mx-auto max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white dark:bg-stone-900 p-5 pb-8">
        <div className="flex items-start justify-between">
          <h2 className="font-display text-xl text-stone-900 dark:text-stone-100">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-full text-lg text-stone-500 dark:text-stone-400 transition-colors hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function CashBreakdownSheet({
  state,
  onClose,
}: {
  state: DashboardState;
  onClose: () => void;
}) {
  const spendable = state.accounts.filter((a) => a.countsAsSpendable);
  return (
    <SheetShell title="Cash on hand" onClose={onClose}>
      <div className="flex flex-col gap-1 pt-3">
        {spendable.map((a) => (
          <div
            key={a.id}
            className="flex items-center justify-between rounded-2xl px-3 py-2.5"
          >
            <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
              {a.name}
            </p>
            <p className="font-display text-lg text-stone-900 dark:text-stone-100">
              {formatMoney(state.balances[a.id] ?? 0, a.currency)}
            </p>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-stone-100 dark:border-stone-800 px-3 pt-3 mt-2">
        <p className="text-sm font-medium text-stone-500 dark:text-stone-400">Total</p>
        <p className="font-display text-xl text-stone-900 dark:text-stone-100">
          {formatMoney(state.cashOnHand, state.baseCurrency ?? "USD")}
        </p>
      </div>
      <p className="px-3 pt-3 text-xs leading-relaxed text-stone-500 dark:text-stone-400">
        Spendable accounts only. Savings, credit cards, and loans are never
        counted here.
      </p>
    </SheetShell>
  );
}

function BreakdownRow({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="px-1 py-2.5">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium text-stone-900 dark:text-stone-100">{label}</p>
        <p className="font-display text-lg text-stone-900 dark:text-stone-100">{value}</p>
      </div>
      {note && (
        <p className="pt-0.5 text-xs leading-relaxed text-stone-500 dark:text-stone-400">
          {note}
        </p>
      )}
    </div>
  );
}

function SafeBreakdownSheet({
  state,
  onClose,
}: {
  state: DashboardState;
  onClose: () => void;
}) {
  const currency = state.baseCurrency ?? "USD";
  const { result, snapshot } = state;
  return (
    <SheetShell title="Safe to spend" onClose={onClose}>
      <p className="-mt-1 pb-1 text-sm leading-relaxed text-stone-600 dark:text-stone-400">
        Available minus committed, spread across the days left. The day's
        number is pinned at midnight and never moves; what's left moves as
        you spend.
      </p>
      <div className="flex flex-col divide-y divide-stone-100 dark:divide-stone-800">
        <BreakdownRow
          label="Today's number"
          value={formatMoney(snapshot.startOfDayAmount, currency)}
          note="Pinned this morning."
        />
        <BreakdownRow
          label="Spent today"
          value={formatMoney(state.todaySpending, currency)}
        />
        <BreakdownRow
          label="Left today"
          value={formatMoney(state.leftToday, currency)}
        />
        <BreakdownRow
          label="Available"
          value={formatMoney(result.available, currency)}
          note="Spendable balances, minus credit-card debt, plus IOUs you're counting on."
        />
        <BreakdownRow
          label="Committed"
          value={formatMoney(result.committed, currency)}
          note="Bills, goal contributions, and your buffer before payday."
        />
        <BreakdownRow
          label="Days covered"
          value={
            state.nextPayday
              ? `${state.cycleDaysLeft} · payday ${formatPayday(state.nextPayday)}`
              : `${state.cycleDaysLeft}-day window`
          }
        />
      </div>
    </SheetShell>
  );
}

export function TodayCards({
  state,
  onPauseGoal,
}: {
  state: DashboardState;
  onPauseGoal: (goalId: string) => void;
}) {
  const [cashOpen, setCashOpen] = useState(false);
  const [safeOpen, setSafeOpen] = useState(false);
  const currency = state.baseCurrency ?? "USD";
  const { result, snapshot, heroState } = state;
  const deficit = heroState === "deficit";

  const cashSubtitle = state.isPaydayToday
    ? "Payday today"
    : state.nextPayday
      ? `Next payday · ${formatPayday(state.nextPayday)}`
      : "No payday set";

  const safeSubtitle = deficit
    ? "of covering everything before payday."
    : `Left today ${formatMoney(state.leftToday, currency)} · ${formatMoney(
        snapshot.startOfDayAmount,
        currency,
      )}/day${
        state.nextPayday ? ` until ${formatPayday(state.nextPayday)}` : ""
      }`;

  return (
    <>
      <section className="grid grid-cols-2 gap-3 max-[380px]:grid-cols-1">
        <button
          type="button"
          onClick={() => setCashOpen(true)}
          className="rounded-3xl border border-indigo-100 dark:border-indigo-900/40 bg-indigo-50/70 dark:bg-indigo-950/40 px-5 py-4 text-left shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-transform active:scale-[0.99]"
        >
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-blue-700 dark:text-blue-300">
            Cash on hand
          </p>
          <p className="pt-2 font-display text-4xl leading-none tracking-tight text-stone-900 dark:text-stone-100">
            {formatMoney(state.cashOnHand, currency)}
          </p>
          <p className="pt-2 text-xs text-stone-500 dark:text-stone-400">{cashSubtitle}</p>
        </button>

        <button
          type="button"
          onClick={() => setSafeOpen(true)}
          className={`rounded-3xl ${SAFE_BG[heroState]} px-5 py-4 text-left shadow-[0_1px_2px_rgba(0,0,0,0.08)] transition-transform active:scale-[0.99]`}
        >
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/80">
            Safe to spend today
          </p>
          {deficit ? (
            <p className="pt-2 font-display text-3xl leading-tight text-white">
              You&rsquo;re{" "}
              <span className="font-semibold">
                {formatMoney(result.shortfall ?? (0 as MinorUnits), currency)}
              </span>{" "}
              short
            </p>
          ) : (
            <p className="pt-2 font-display text-4xl leading-none tracking-tight text-white">
              {formatMoney(snapshot.startOfDayAmount, currency)}
            </p>
          )}
          <p className="pt-2 text-xs leading-relaxed text-white/80">{safeSubtitle}</p>
        </button>
      </section>

      {deficit && state.deficitPauseSuggestion && (
        <button
          type="button"
          onClick={() => onPauseGoal(state.deficitPauseSuggestion!.goalId)}
          className="mt-3 w-full rounded-2xl bg-stone-900 dark:bg-stone-100 px-4 py-3 text-sm font-medium text-white dark:text-stone-900 transition-colors hover:bg-stone-700 dark:hover:bg-stone-200"
        >
          Pause {state.deficitPauseSuggestion.goalName} (
          {formatMoney(state.deficitPauseSuggestion.amount, currency)} this cycle)
        </button>
      )}

      {cashOpen && <CashBreakdownSheet state={state} onClose={() => setCashOpen(false)} />}
      {safeOpen && <SafeBreakdownSheet state={state} onClose={() => setSafeOpen(false)} />}
    </>
  );
}

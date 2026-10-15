/**
 * The daily number. Reads in one second: the big safe-to-spend figure,
 * what's left today, and days left in the cycle. Color states per spec:
 * normal / amber (left today under 20% of daily) / red (overspent today)
 * / deficit ("You're $X short…", never a negative number).
 */
import type { DashboardState } from "../app/dashboard.js";
import { formatMoney, formatWhole } from "../app/format.js";

const NUMBER_COLOR: Record<DashboardState["heroState"], string> = {
  normal: "text-stone-900 dark:text-stone-100",
  amber: "text-amber-700 dark:text-amber-300",
  red: "text-red-700 dark:text-red-300",
  deficit: "text-stone-900 dark:text-stone-100",
};

function formatPayday(date: string): string {
  const [, m, d] = date.split("-");
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[Number(m) - 1]} ${Number(d)}`;
}

export function SafeToSpendHero({
  state,
  onPauseGoal,
}: {
  state: DashboardState;
  onPauseGoal: (goalId: string) => void;
}) {
  const { result, snapshot, heroState, cycleDaysLeft, nextPayday, deficitPauseSuggestion } =
    state;
  const currency = state.baseCurrency ?? "USD";

  return (
    <section className="rounded-3xl border border-stone-200/70 dark:border-stone-700 bg-white dark:bg-stone-900 px-6 pb-6 pt-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400">
          Safe to spend
        </p>
        <p className="rounded-full bg-stone-100 dark:bg-stone-800 px-3 py-1 text-xs font-medium text-stone-600 dark:text-stone-400">
          {nextPayday
            ? `${cycleDaysLeft} day${cycleDaysLeft === 1 ? "" : "s"} left · payday ${formatPayday(nextPayday)}`
            : `${cycleDaysLeft}-day window`}
        </p>
      </div>

      {heroState === "deficit" ? (
        <div className="pt-4">
          <p className="font-display text-4xl leading-tight text-stone-900 dark:text-stone-100">
            You&rsquo;re{" "}
            <span className="text-red-700 dark:text-red-300">
              {formatMoney(result.shortfall ?? 0, currency)}
            </span>{" "}
            short
          </p>
          <p className="pt-2 text-sm leading-relaxed text-stone-600 dark:text-stone-400">
            of covering everything before payday.
          </p>
          {deficitPauseSuggestion && (
            <button
              type="button"
              onClick={() => onPauseGoal(deficitPauseSuggestion.goalId)}
              className="mt-4 w-full rounded-2xl bg-stone-900 dark:bg-stone-100 px-4 py-3 text-sm font-medium text-white dark:text-stone-900 transition-colors hover:bg-stone-700 dark:hover:bg-stone-200"
            >
              Pause {deficitPauseSuggestion.goalName} (
              {formatMoney(deficitPauseSuggestion.amount, currency)} this cycle)
            </button>
          )}
        </div>
      ) : (
        <div className="pt-2">
          <p className={`font-display text-7xl leading-none tracking-tight ${NUMBER_COLOR[heroState]}`}>
            {formatWhole(snapshot.startOfDayAmount, currency)}
          </p>
          <div className="flex items-baseline justify-between pt-3">
            <p className="text-sm text-stone-600 dark:text-stone-400">
              <span className="font-semibold text-stone-900 dark:text-stone-100">
                {formatMoney(state.leftToday, currency)}
              </span>{" "}
              left today
            </p>
            {heroState === "amber" && (
              <p className="rounded-full bg-amber-50 dark:bg-amber-950 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-300 ring-1 ring-inset ring-amber-200 dark:ring-amber-800">
                Running low
              </p>
            )}
            {heroState === "red" && (
              <p className="rounded-full bg-red-50 dark:bg-red-950 px-2.5 py-1 text-xs font-medium text-red-700 dark:text-red-300 ring-1 ring-inset ring-red-200 dark:ring-red-800">
                Over budget today
              </p>
            )}
          </div>
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-stone-100 dark:border-stone-800 pt-4">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-stone-400">
            Available
          </p>
          <p className="pt-0.5 text-base font-semibold text-stone-800 dark:text-stone-200">
            {formatMoney(result.available, currency)}
          </p>
        </div>
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-stone-400">
            Committed
          </p>
          <p className="pt-0.5 text-base font-semibold text-stone-800 dark:text-stone-200">
            {formatMoney(result.committed, currency)}
          </p>
        </div>
      </div>
    </section>
  );
}

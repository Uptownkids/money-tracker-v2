/**
 * Today's Moves: at most 3 actions that genuinely matter today, ranked by
 * the engine. Rows are tappable (open the relevant sheet or tab) and
 * carry one-tap actions: Mark paid / Mark cleared settles the row,
 * Snooze hides the move until tomorrow.
 */
import type { TodaysMove } from "../domain/engine/todaysMoves.js";
import { formatMoney } from "../app/format.js";

const KIND_LABEL: Record<TodaysMove["kind"], string> = {
  "overdue-bill": "Overdue",
  "payday-run": "Payday",
  "bill-due-soon": "Due soon",
  "stale-pending": "Confirm",
  "old-iou": "IOU",
  "unused-subscription": "Subscription",
};

const markPaidPill =
  "shrink-0 rounded-full bg-stone-900 dark:bg-stone-100 px-3.5 py-1.5 text-xs font-medium text-white dark:text-stone-900 transition-colors hover:bg-stone-700 dark:hover:bg-stone-200";
const snoozePill =
  "shrink-0 rounded-full border border-stone-200 dark:border-stone-700 px-3.5 py-1.5 text-xs font-medium text-stone-600 dark:text-stone-400 transition-colors hover:bg-stone-50 dark:hover:bg-stone-800";

export function TodaysMoves({
  moves,
  onOpen,
  onMarkPaid,
  onSnooze,
  baseCurrency = "USD",
}: {
  moves: TodaysMove[];
  onOpen: (move: TodaysMove) => void;
  onMarkPaid: (move: TodaysMove) => void;
  onSnooze: (move: TodaysMove) => void;
  /** Base currency for move amounts; the coordinator passes the setting. */
  baseCurrency?: string;
}) {
  if (moves.length === 0) {
    return (
      <section className="rounded-3xl border border-stone-200/70 dark:border-stone-700 bg-white dark:bg-stone-900 px-6 py-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400">
          Today&rsquo;s moves
        </p>
        <p className="pt-2 text-sm text-stone-600 dark:text-stone-400">Nothing needs you today. Enjoy it.</p>
      </section>
    );
  }

  return (
    <section className="rounded-3xl border border-stone-200/70 dark:border-stone-700 bg-white dark:bg-stone-900 px-2 py-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <p className="px-4 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400">
        Today&rsquo;s moves
      </p>
      <div className="divide-y divide-stone-100 dark:divide-stone-800">
        {moves.map((move) => {
          const canMarkPaid = move.actions.includes("mark-paid");
          const canSnooze = move.actions.includes("snooze");
          return (
            <div key={move.id} className="flex items-center gap-2 px-4 py-2.5">
              <button
                type="button"
                onClick={() => onOpen(move)}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-xl py-1 text-left transition-colors hover:bg-stone-50 dark:hover:bg-stone-800"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-stone-100 dark:bg-stone-800 text-[11px] font-semibold text-stone-600 dark:text-stone-400">
                  {move.priority}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-stone-900 dark:text-stone-100">
                    {move.title}
                  </span>
                  <span className="block pt-0.5 text-xs text-stone-500 dark:text-stone-400">
                    {KIND_LABEL[move.kind]}
                    {move.amount !== undefined ? ` · ${formatMoney(move.amount, baseCurrency)}` : ""}
                  </span>
                </span>
                <span className="shrink-0 text-stone-300 dark:text-stone-600" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M6 4l4 4-4 4"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </button>
              {canMarkPaid && (
                <button
                  type="button"
                  onClick={() => onMarkPaid(move)}
                  className={markPaidPill}
                >
                  {move.kind === "stale-pending" ? "Mark cleared" : "Mark paid"}
                </button>
              )}
              {canSnooze && (
                <button
                  type="button"
                  onClick={() => onSnooze(move)}
                  className={snoozePill}
                >
                  Snooze
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

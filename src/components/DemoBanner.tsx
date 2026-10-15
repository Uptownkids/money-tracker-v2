/**
 * Demo-mode banner. The demo dataset lives in a SEPARATE Dexie database
 * ("money-tracker-demo") and is clearly labeled DEMO. Loading and wiping
 * are explicit taps — never automatic — and wiping the demo can never
 * touch real data.
 */
import { isDemoMode, loadDemoData, wipeDemoData } from "../app/seed.js";

export function DemoBanner({ onChanged }: { onChanged: () => void }) {
  const wipe = async () => {
    await wipeDemoData();
    onChanged();
  };

  const load = async () => {
    await loadDemoData();
    onChanged();
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl bg-stone-900 dark:bg-stone-100 px-4 py-2.5">
      <p className="text-xs font-medium tracking-wide text-stone-200 dark:text-stone-700">
        <span className="font-semibold text-white">DEMO DATA</span>
        <span className="text-stone-400"> · sample dataset, not your money</span>
      </p>
      {isDemoMode() ? (
        <button
          type="button"
          onClick={wipe}
          className="shrink-0 rounded-full bg-stone-800 dark:bg-stone-200 px-3 py-1.5 text-xs font-medium text-stone-200 dark:text-stone-700 ring-1 ring-inset ring-stone-700 dark:ring-stone-300 transition-colors hover:bg-stone-700 dark:hover:bg-stone-200"
        >
          Wipe demo
        </button>
      ) : (
        <button
          type="button"
          onClick={load}
          className="shrink-0 rounded-full bg-stone-100 dark:bg-stone-800 px-3 py-1.5 text-xs font-medium text-stone-900 dark:text-stone-100 transition-colors hover:bg-white dark:hover:bg-stone-900"
        >
          Load demo
        </button>
      )}
    </div>
  );
}

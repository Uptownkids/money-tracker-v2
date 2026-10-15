/**
 * Goals: the goal list with derived progress, plus add/edit sheets.
 * Saved amounts are always derived via deriveGoalSaved — never stored.
 */
import { useCallback, useEffect, useState } from "react";
import { createRepositories } from "../data/repositories/index.js";
import { getActiveDb } from "../data/db.js";
import { parseDollarsToMinor } from "../app/quickLog.js";
import { formatMoney } from "../app/format.js";
import { deriveGoalSaved } from "../domain/engine/goals.js";
import {
  dayOfMonth,
  isDateOnly,
  monthOf,
  yearOf,
  type DateOnly,
} from "../domain/dates/dateOnly.js";
import { decimalsOf } from "../domain/money/currency.js";
import type { Account } from "../domain/entities/account.js";
import type { Goal } from "../domain/entities/goal.js";
import type { Transaction } from "../domain/entities/transaction.js";
import type { MinorUnits } from "../domain/money/money.js";

const fieldCls =
  "w-full rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-3.5 py-2.5 text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 focus:border-stone-400 dark:focus:border-stone-500 focus:outline-none";
const labelCls = "mb-1.5 block text-xs font-medium text-stone-500 dark:text-stone-400";
const helpCls = "pt-1.5 text-xs text-stone-500 dark:text-stone-400";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatDateOnly(d: DateOnly): string {
  return `${MONTHS[monthOf(d) - 1]} ${dayOfMonth(d)}, ${yearOf(d)}`;
}

/** Minor units back to a dollars text string (integer math only). */
function minorToDollarsText(minor: MinorUnits, currency: string): string {
  const d = decimalsOf(currency);
  const div = 10 ** d;
  const whole = Math.trunc(minor / div);
  const frac = minor - whole * div;
  return d === 0 ? String(whole) : `${whole}.${String(frac).padStart(d, "0")}`;
}

function SheetShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
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

function GoalFormSheet({
  goal,
  savingsAccounts,
  defaultPriority,
  onClose,
  onSaved,
}: {
  goal: Goal | null;
  savingsAccounts: Account[];
  defaultPriority: number;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const editing = goal !== null;
  const [name, setName] = useState(goal?.name ?? "");
  const [amount, setAmount] = useState(
    goal ? minorToDollarsText(goal.targetAmount, goal.currency) : "",
  );
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? "");
  const [linkedAccountId, setLinkedAccountId] = useState(
    goal?.linkedSavingsAccountId ?? "",
  );
  const [priority, setPriority] = useState(
    goal ? String(goal.priority) : String(defaultPriority),
  );
  const [override, setOverride] = useState(
    goal?.contributionPerCycleOverride !== undefined
      ? minorToDollarsText(goal.contributionPerCycleOverride, goal.currency)
      : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setError(null);
    const trimmedName = name.trim();
    if (trimmedName === "") {
      setError("Give the goal a name.");
      return;
    }
    const linkedAccount = savingsAccounts.find((a) => a.id === linkedAccountId);
    const currency = editing ? goal.currency : (linkedAccount?.currency ?? "USD");

    let targetMinor: MinorUnits | null;
    try {
      targetMinor = parseDollarsToMinor(amount, currency);
    } catch {
      setError("Unknown currency code — use a 3-letter code like USD.");
      return;
    }
    if (targetMinor === null) {
      setError("Enter a target amount like 500.00");
      return;
    }

    let dateValue: DateOnly | undefined;
    const dateTrim = targetDate.trim();
    if (dateTrim !== "") {
      if (!isDateOnly(dateTrim)) {
        setError("Enter the target date as YYYY-MM-DD.");
        return;
      }
      dateValue = dateTrim;
    }

    const prioTrim = priority.trim();
    const prio = prioTrim === "" ? NaN : Number(prioTrim);
    if (!Number.isInteger(prio) || prio < 0) {
      setError("Priority must be a whole number (1 = pause first).");
      return;
    }

    let overrideValue: MinorUnits | undefined;
    const overrideTrim = override.trim();
    if (overrideTrim !== "") {
      let parsed: MinorUnits | null;
      try {
        parsed = parseDollarsToMinor(overrideTrim, currency);
      } catch {
        setError("Unknown currency code — use a 3-letter code like USD.");
        return;
      }
      if (parsed === null) {
        setError("Enter the per-cycle amount like 100.00, or leave blank.");
        return;
      }
      overrideValue = parsed;
    }

    setSaving(true);
    try {
      const now = new Date().toISOString();
      const next: Goal = editing
        ? {
            ...goal,
            name: trimmedName,
            targetAmount: targetMinor,
            currency,
            priority: prio,
            updatedAt: now,
          }
        : {
            id: crypto.randomUUID(),
            name: trimmedName,
            targetAmount: targetMinor,
            currency,
            pinnedContribution: null,
            priority: prio,
            paused: false,
            createdAt: now,
            updatedAt: now,
          };
      if (dateValue === undefined) {
        delete next.targetDate;
      } else {
        next.targetDate = dateValue;
      }
      if (linkedAccountId === "") {
        delete next.linkedSavingsAccountId;
      } else {
        next.linkedSavingsAccountId = linkedAccountId;
      }
      if (overrideValue === undefined) {
        delete next.contributionPerCycleOverride;
      } else {
        next.contributionPerCycleOverride = overrideValue;
      }
      const repos = createRepositories(getActiveDb());
      await repos.goals.put(next);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
      setSaving(false);
    }
  };

  const idp = editing ? "ge" : "g";

  return (
    <SheetShell title={editing ? "Edit goal" : "Add goal"} onClose={onClose}>
      <div className="mt-4 flex flex-col gap-4">
        <div>
          <label htmlFor={`${idp}-name`} className={labelCls}>
            Name
          </label>
          <input
            id={`${idp}-name`}
            type="text"
            placeholder="Emergency fund"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={fieldCls}
          />
        </div>

        <div>
          <label htmlFor={`${idp}-amount`} className={labelCls}>
            Target amount
          </label>
          <input
            id={`${idp}-amount`}
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={`${fieldCls} font-display text-2xl`}
          />
        </div>

        <div>
          <label htmlFor={`${idp}-date`} className={labelCls}>
            Target date (optional)
          </label>
          <input
            id={`${idp}-date`}
            type="date"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
            className={fieldCls}
          />
          <p className={helpCls}>
            Leave blank for no target date — the goal plans over 1 year.
          </p>
        </div>

        <div>
          <label htmlFor={`${idp}-account`} className={labelCls}>
            Linked savings account (optional)
          </label>
          <select
            id={`${idp}-account`}
            value={linkedAccountId}
            onChange={(e) => setLinkedAccountId(e.target.value)}
            className={fieldCls}
          >
            <option value="">None</option>
            {savingsAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor={`${idp}-priority`} className={labelCls}>
            Priority
          </label>
          <input
            id={`${idp}-priority`}
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className={fieldCls}
          />
          <p className={helpCls}>
            Lower number = suggested to pause first in a deficit.
          </p>
        </div>

        <div>
          <label htmlFor={`${idp}-override`} className={labelCls}>
            Per-cycle contribution (optional)
          </label>
          <input
            id={`${idp}-override`}
            type="text"
            inputMode="decimal"
            placeholder="Auto"
            value={override}
            onChange={(e) => setOverride(e.target.value)}
            className={fieldCls}
          />
          <p className={helpCls}>
            Leave blank to auto-spread the remaining amount over the horizon.
          </p>
        </div>

        {error && <p className="text-sm font-medium text-red-700 dark:text-red-300">{error}</p>}

        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-full bg-stone-900 dark:bg-stone-100 py-3 text-sm font-medium text-white dark:text-stone-900 transition-colors hover:bg-stone-700 dark:hover:bg-stone-200 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </SheetShell>
  );
}

function GoalCard({
  goal,
  saved,
  onEdit,
  onTogglePaused,
}: {
  goal: Goal;
  saved: MinorUnits;
  onEdit: () => void;
  onTogglePaused: () => void;
}) {
  const pct =
    goal.targetAmount > 0
      ? Math.max(0, Math.min(100, Math.round((saved * 100) / goal.targetAmount)))
      : 0;
  return (
    <div
      className={`rounded-2xl border border-stone-100 dark:border-stone-800 px-4 py-3.5 ${
        goal.paused ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-stone-900 dark:text-stone-100">{goal.name}</p>
          <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
            <span className="rounded-full bg-stone-100 dark:bg-stone-800 px-2 py-0.5 text-[11px] font-medium text-stone-600 dark:text-stone-400">
              Pause #{goal.priority}
            </span>
            {goal.paused && (
              <span className="rounded-full bg-stone-900 dark:bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-white dark:text-stone-900">
                Paused
              </span>
            )}
            {goal.contributionPerCycleOverride !== undefined && (
              <span className="rounded-full bg-stone-100 dark:bg-stone-800 px-2 py-0.5 text-[11px] font-medium text-stone-600 dark:text-stone-400">
                {formatMoney(goal.contributionPerCycleOverride, goal.currency)}/cycle
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={onTogglePaused}
            className="text-xs font-medium text-stone-500 dark:text-stone-400 transition-colors hover:text-stone-900 dark:hover:text-stone-100"
          >
            {goal.paused ? "Resume" : "Pause"}
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="text-xs font-medium text-stone-500 dark:text-stone-400 transition-colors hover:text-stone-900 dark:hover:text-stone-100"
          >
            Edit
          </button>
        </div>
      </div>

      <div className="pt-3">
        <div
          className="h-2 overflow-hidden rounded-full bg-stone-100 dark:bg-stone-800"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${goal.name} progress`}
        >
          <div
            className="h-full rounded-full bg-stone-900 dark:bg-stone-100 transition-[width]"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex items-baseline justify-between pt-1.5">
          <p className="text-xs text-stone-500 dark:text-stone-400">
            <span className="font-display text-sm font-medium text-stone-900 dark:text-stone-100">
              {formatMoney(saved, goal.currency)}
            </span>{" "}
            of {formatMoney(goal.targetAmount, goal.currency)}
          </p>
          <p className="text-xs font-medium text-stone-500 dark:text-stone-400">{pct}%</p>
        </div>
      </div>

      <p className="pt-1 text-xs text-stone-500 dark:text-stone-400">
        {goal.targetDate ? formatDateOnly(goal.targetDate) : "No target date"}
      </p>
    </div>
  );
}

export function Goals({ onChanged }: { onChanged: () => void }) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [savingsAccounts, setSavingsAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);

  const load = useCallback(async () => {
    const repos = createRepositories(getActiveDb());
    const [gs, txs, accts] = await Promise.all([
      repos.goals.getAll(),
      repos.transactions.getAll(),
      repos.accounts.getAll(),
    ]);
    setGoals(gs);
    setTransactions(txs);
    setSavingsAccounts(accts.filter((a) => a.type === "Savings" && !a.archived));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const afterWrite = useCallback(async () => {
    await load();
    onChanged();
  }, [load, onChanged]);

  const togglePaused = useCallback(
    async (goal: Goal) => {
      const repos = createRepositories(getActiveDb());
      await repos.goals.put({
        ...goal,
        paused: !goal.paused,
        updatedAt: new Date().toISOString(),
      });
      await afterWrite();
    },
    [afterWrite],
  );

  const sorted = [...goals].sort(
    (a, b) => a.priority - b.priority || a.name.localeCompare(b.name),
  );
  const defaultPriority =
    goals.length === 0 ? 1 : Math.max(...goals.map((g) => g.priority)) + 1;

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-stone-300 dark:border-stone-600 border-t-stone-800 dark:border-t-stone-200" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-3xl border border-stone-200/70 dark:border-stone-700 bg-white dark:bg-stone-900 px-4 py-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <div className="flex items-center justify-between pb-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400">
            Goals
          </p>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="rounded-full bg-stone-900 dark:bg-stone-100 px-3.5 py-1.5 text-xs font-medium text-white dark:text-stone-900 transition-colors hover:bg-stone-700 dark:hover:bg-stone-200"
          >
            Add goal
          </button>
        </div>

        {sorted.length === 0 ? (
          <p className="px-1 py-6 text-center text-sm text-stone-500 dark:text-stone-400">
            No goals yet. Add one to start planning.
          </p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {sorted.map((g) => (
              <GoalCard
                key={g.id}
                goal={g}
                saved={deriveGoalSaved(g.id, transactions)}
                onEdit={() => setEditing(g)}
                onTogglePaused={() => void togglePaused(g)}
              />
            ))}
          </div>
        )}
      </section>

      {addOpen && (
        <GoalFormSheet
          goal={null}
          savingsAccounts={savingsAccounts}
          defaultPriority={defaultPriority}
          onClose={() => setAddOpen(false)}
          onSaved={async () => {
            setAddOpen(false);
            await afterWrite();
          }}
        />
      )}

      {editing && (
        <GoalFormSheet
          key={editing.id}
          goal={editing}
          savingsAccounts={savingsAccounts}
          defaultPriority={defaultPriority}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await afterWrite();
          }}
        />
      )}
    </div>
  );
}

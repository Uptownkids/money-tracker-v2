/**
 * First-launch onboarding: the welcome screen, the start-fresh wizard,
 * and the v1 migration path. Owns the whole flow; App renders this
 * instead of the tab UI when the onboarding gate fires.
 *
 * All money is integer minor units. All dates are UTC DateOnly strings.
 * Writes go to the real database through repositories. The demo path uses
 * the existing loadDemoData() flow and the demo database.
 */
import { useRef, useState, type ReactNode } from "react";
import { createRepositories } from "../data/repositories/index.js";
import { getDb, getDemoDb } from "../data/db.js";
import { loadDemoData } from "../app/seed.js";
import { loadDashboardState, type DashboardState } from "../app/dashboard.js";
import { formatMoney, formatWhole } from "../app/format.js";
import { parseDollarsToMinor } from "../app/quickLog.js";
import {
  migrateFromV1,
  type MigrationResult,
  type V1Dashboard,
} from "../data/migration/fromV1.js";
import { importMigratedResult } from "../data/migration/importMigrated.js";
import {
  markOnboardingComplete,
  realRepositories,
  reconciliationDiffs,
  validateV1Shape,
  writeFreshOnboarding,
  type FreshAccountDraft,
  type FreshBillDraft,
  type FreshGoalDraft,
  type FreshOnboardingDraft,
  type FreshPaydayDraft,
  type ReconciliationRow,
} from "../app/onboarding.js";
import {
  clampDayOfMonth,
  compareDateOnly,
  isDateOnly,
  monthOf,
  todayLocal,
  yearOf,
  type DateOnly,
} from "../domain/dates/dateOnly.js";
import type { AccountType } from "../domain/entities/account.js";
import type { MinorUnits } from "../domain/money/money.js";

type Screen =
  | "welcome"
  | "fresh-accounts"
  | "fresh-payday"
  | "fresh-bills"
  | "fresh-goal"
  | "fresh-reveal"
  | "migrate-info"
  | "migrate-upload"
  | "migrate-review";

const ACCOUNT_TYPES: AccountType[] = ["Checking", "Savings", "Cash", "CreditCard", "Loan", "Other"];

const fieldCls =
  "w-full rounded-xl border border-stone-200 bg-white px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100 dark:placeholder:text-stone-500";
const labelCls = "mb-1.5 block text-xs font-medium text-stone-500 dark:text-stone-400";
const primaryBtn =
  "w-full rounded-full bg-stone-900 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-stone-700 disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200";
const secondaryBtn =
  "w-full rounded-full border border-stone-300 px-6 py-3 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-200 disabled:opacity-40 dark:border-stone-600 dark:text-stone-200 dark:hover:bg-stone-800";

interface AccountRow {
  id: string;
  name: string;
  type: AccountType;
  balance: string;
}

interface BillRow {
  id: string;
  name: string;
  amount: string;
  dueDate: string;
  accountId: string;
}

interface MigratedFile {
  /** The parsed v1 dashboard, kept so edits re-run the migration in memory. */
  v1: V1Dashboard;
  /** The opts the migration was run with, reused on every re-run. */
  migrationDate: DateOnly;
  nowIso: string;
  migrated: MigrationResult;
  rows: ReconciliationRow[];
  warnings: string[];
}

/** Re-run the v1 migration in memory with the current trip inputs. */
function recomputeMigration(
  v1: V1Dashboard,
  tripLeaveDate: string,
  tripSetAside: string,
  migrationDate: DateOnly,
  nowIso: string,
): MigratedFile {
  const setAsideMinor =
    tripSetAside.trim() === "" ? 0 : (parseDollarsToMinor(tripSetAside) ?? 0);
  const tripGoal =
    (v1.trip_expenses ?? []).length > 0
      ? {
          targetDate: isDateOnly(tripLeaveDate) ? tripLeaveDate : undefined,
          setAsideMinor,
        }
      : undefined;
  const migrated = migrateFromV1(v1, { migrationDate, nowIso, tripGoal });
  return { v1, migrationDate, nowIso, migrated, rows: reconciliationDiffs(v1, migrated), warnings: migrated.warnings };
}

/** Next date on/after `from` with the given day-of-month (clamped). */
function nextDomOnOrAfter(from: DateOnly, dom: number): DateOnly {
  const y = yearOf(from);
  const m = monthOf(from);
  const thisMonth = clampDayOfMonth(y, m, dom);
  if (compareDateOnly(thisMonth, from) >= 0) return thisMonth;
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  return clampDayOfMonth(ny, nm, dom);
}

/** Dollars text -> minor units, allowing zero (accounts can start at 0). */
function parseBalance(text: string): MinorUnits | null {
  const t = text.trim().replace(/[$,\s]/g, "");
  if (t === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const parts = t.split(".");
  const whole = parts[0];
  const frac = parts[1] ?? "";
  if (whole === undefined) return null;
  const minor = Number(whole + frac.padEnd(2, "0"));
  return Number.isSafeInteger(minor) && minor >= 0 ? minor : null;
}

function Shell({
  step,
  title,
  sub,
  onSkip,
  children,
}: {
  step?: string;
  title: string;
  sub?: string;
  onSkip?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-stone-100 dark:bg-stone-950">
      <div className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 pb-16 pt-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            {step && (
              <p className="text-xs font-medium uppercase tracking-widest text-stone-400 dark:text-stone-500">
                {step}
              </p>
            )}
            <h1 className="font-display mt-1 text-3xl text-stone-900 dark:text-stone-100">{title}</h1>
            {sub && <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">{sub}</p>}
          </div>
          {onSkip && (
            <button
              type="button"
              onClick={onSkip}
              className="shrink-0 pt-1 text-sm font-medium text-stone-500 underline decoration-stone-300 underline-offset-4 hover:text-stone-700 dark:text-stone-400 dark:decoration-stone-600 dark:hover:text-stone-200"
            >
              Skip
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

function ErrorList({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <div className="rounded-2xl bg-red-50 px-4 py-3 ring-1 ring-inset ring-red-200 dark:bg-red-950/40 dark:ring-red-900">
      <ul className="list-disc space-y-1 pl-5 text-sm text-red-800 dark:text-red-200">
        {errors.map((e, i) => (
          <li key={i}>{e}</li>
        ))}
      </ul>
    </div>
  );
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [screen, setScreen] = useState<Screen>("welcome");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh-wizard drafts. completedUpTo tracks validated steps so Skip can
  // write exactly what was finished: 1 = accounts, 2 = payday, 3 = bills.
  const [completedUpTo, setCompletedUpTo] = useState(0);
  const [accountRows, setAccountRows] = useState<AccountRow[]>(() => [
    { id: crypto.randomUUID(), name: "", type: "Checking", balance: "" },
  ]);
  const [payday, setPayday] = useState(() => {
    const t = todayLocal();
    return {
      amount: "",
      frequency: "semi-monthly" as "semi-monthly" | "monthly",
      dateA: nextDomOnOrAfter(t, 15),
      dateB: nextDomOnOrAfter(t, 30),
    };
  });
  const [billRows, setBillRows] = useState<BillRow[]>(() => [
    {
      id: crypto.randomUUID(),
      name: "",
      amount: "",
      dueDate: nextDomOnOrAfter(todayLocal(), 1),
      accountId: "",
    },
  ]);
  const [goal, setGoal] = useState({ name: "", target: "", targetDate: "" });

  const [reveal, setReveal] = useState<{ state: DashboardState; currency: string } | null>(null);

  // Migration state.
  const [v1File, setV1File] = useState<MigratedFile | null>(null);
  const [v1Errors, setV1Errors] = useState<string[]>([]);
  const [fileName, setFileName] = useState("");
  // LA trip inputs on the migrate-review screen. Editing either re-runs
  // the migration in memory; nothing is written until import.
  const [tripLeaveDate, setTripLeaveDate] = useState("");
  const [tripSetAside, setTripSetAside] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const resetFileInput = () => {
    if (fileRef.current) fileRef.current.value = "";
    setFileName("");
  };

  // ---------- draft builders (throw a user-facing Error on bad input) ----------

  const buildAccounts = (): FreshAccountDraft[] => {
    const drafts: FreshAccountDraft[] = [];
    for (const [i, row] of accountRows.entries()) {
      const blank = row.name.trim() === "" && row.balance.trim() === "";
      if (blank) continue;
      if (row.name.trim() === "") throw new Error(`Account ${i + 1} needs a name.`);
      const entered = parseBalance(row.balance);
      if (entered === null) throw new Error(`"${row.name.trim()}" has an invalid balance. Use numbers like 1350 or 1488.35.`);
      drafts.push({ id: row.id, name: row.name.trim(), type: row.type, enteredMinor: entered });
    }
    if (drafts.length === 0) throw new Error("Add at least one account with a name and a balance.");
    return drafts;
  };

  const buildPayday = (): FreshPaydayDraft => {
    const amountMinor = parseDollarsToMinor(payday.amount);
    if (amountMinor === null) throw new Error("Enter your pay amount, like 2263.41.");
    const rawDates = payday.frequency === "semi-monthly" ? [payday.dateA, payday.dateB] : [payday.dateA];
    const dates: DateOnly[] = [];
    for (const d of rawDates) {
      if (!isDateOnly(d)) throw new Error("Pick a valid payday date.");
      if (compareDateOnly(d, todayLocal()) < 0) throw new Error("Pick today or a future date for payday.");
      dates.push(d);
    }
    return { amountMinor, dates, frequency: payday.frequency };
  };

  const buildBills = (accounts: FreshAccountDraft[]): FreshBillDraft[] => {
    const drafts: FreshBillDraft[] = [];
    for (const [i, row] of billRows.entries()) {
      const blank = row.name.trim() === "" && row.amount.trim() === "" && row.dueDate.trim() === "";
      if (blank) continue;
      if (row.name.trim() === "") throw new Error(`Bill ${i + 1} needs a name.`);
      const amountMinor = parseDollarsToMinor(row.amount);
      if (amountMinor === null) throw new Error(`"${row.name.trim()}" has an invalid amount.`);
      if (!isDateOnly(row.dueDate)) throw new Error(`"${row.name.trim()}" needs a valid due date.`);
      if (compareDateOnly(row.dueDate, todayLocal()) < 0)
        throw new Error(`"${row.name.trim()}" is due in the past. Pick today or a future date.`);
      const accountId = accounts.some((a) => a.id === row.accountId) ? row.accountId : accounts[0]!.id;
      drafts.push({ id: row.id, name: row.name.trim(), amountMinor, nextDueDate: row.dueDate, accountId });
    }
    return drafts;
  };

  const buildGoal = (): FreshGoalDraft | null => {
    const blank = goal.name.trim() === "" && goal.target.trim() === "" && goal.targetDate.trim() === "";
    if (blank) return null;
    if (goal.name.trim() === "") throw new Error("Give your goal a name.");
    const targetMinor = parseDollarsToMinor(goal.target);
    if (targetMinor === null) throw new Error("Enter a target amount for your goal, like 10000.");
    let targetDate: DateOnly | undefined;
    if (goal.targetDate.trim() !== "") {
      if (!isDateOnly(goal.targetDate)) throw new Error("The goal target date is not valid.");
      targetDate = goal.targetDate;
    }
    return { name: goal.name.trim(), targetMinor, targetDate };
  };

  const buildDraft = (upTo: number, includeGoal: boolean): FreshOnboardingDraft => {
    const accounts = buildAccounts();
    const paydayDraft = upTo >= 2 ? buildPayday() : null;
    const bills = upTo >= 3 ? buildBills(accounts) : [];
    return {
      accounts,
      payday: paydayDraft,
      bills,
      goal: includeGoal ? buildGoal() : null,
    };
  };

  // ---------- fresh flow actions ----------
  //
  // All onboarding writes go through realRepositories(): it switches
  // demo mode off first so writes land in the real database. The
  // Load-demo path keeps using the demo database.

  const finishOpts = () => ({ today: todayLocal(), nowIso: new Date().toISOString() });

  /** Skip: write the validated steps so far (dropping anything half-filled),
   * set the flag, and land in the app. Never throws on draft problems. */
  const skipAll = async () => {
    setBusy(true);
    setError(null);
    try {
      let accounts: FreshAccountDraft[] = [];
      try {
        accounts = buildAccounts();
      } catch {
        // half-filled rows are dropped on skip; the flag still gets set
      }
      let paydayDraft: FreshPaydayDraft | null = null;
      let bills: FreshBillDraft[] = [];
      if (completedUpTo >= 2 && accounts.length > 0) {
        try {
          paydayDraft = buildPayday();
        } catch {
          // drop
        }
      }
      if (completedUpTo >= 3 && accounts.length > 0) {
        try {
          bills = buildBills(accounts);
        } catch {
          // drop
        }
      }
      if (accounts.length > 0) {
        await writeFreshOnboarding(realRepositories(), { accounts, payday: paydayDraft, bills, goal: null }, finishOpts());
      }
      await markOnboardingComplete(realRepositories());
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  };

  /** Final wizard step: write everything, compute the first number, reveal. */
  const finishFresh = async () => {
    setBusy(true);
    setError(null);
    try {
      // realRepositories() runs first: it turns demo mode off, so the
      // loadDashboardState() below reads the real database.
      const r = realRepositories();
      const draft = buildDraft(3, true);
      await writeFreshOnboarding(r, draft, finishOpts());
      const state = await loadDashboardState();
      const settings = await r.settings.get();
      setReveal({ state, currency: settings?.baseCurrency ?? "USD" });
      setScreen("fresh-reveal");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const enterApp = async () => {
    setBusy(true);
    try {
      await markOnboardingComplete(realRepositories());
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  };

  const loadDemo = async () => {
    setBusy(true);
    setError(null);
    try {
      await loadDemoData();
      await markOnboardingComplete(createRepositories(getDemoDb()));
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The demo could not load. Try again.");
      setBusy(false);
    }
  };

  // ---------- migrate flow actions ----------

  const pickFile = async (file: File | undefined) => {
    setV1Errors([]);
    setV1File(null);
    setTripLeaveDate("");
    setTripSetAside("");
    if (!file) return;
    setFileName(file.name);
    setBusy(true);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        setV1Errors(["This file is not valid JSON. Download the backup from the old tracker and try again."]);
        return;
      }
      const check = validateV1Shape(parsed);
      if (!check.ok) {
        setV1Errors(check.errors);
        return;
      }
      const v1 = parsed as V1Dashboard;
      setV1File(recomputeMigration(v1, "", "", todayLocal(), new Date().toISOString()));
      setScreen("migrate-review");
    } finally {
      setBusy(false);
    }
  };

  const tryDifferentFile = () => {
    resetFileInput();
    setV1File(null);
    setV1Errors([]);
    setTripLeaveDate("");
    setTripSetAside("");
    setScreen("migrate-upload");
  };

  /** Trip input edit: re-run the migration in memory and refresh the screen. */
  const onTripFieldChange = (leaveDate: string, setAside: string) => {
    setTripLeaveDate(leaveDate);
    setTripSetAside(setAside);
    setV1File((prev) =>
      prev ? recomputeMigration(prev.v1, leaveDate, setAside, prev.migrationDate, prev.nowIso) : prev,
    );
  };

  /** The "already set aside" field is valid when blank or a dollar amount. */
  const tripSetAsideValid =
    tripSetAside.trim() === "" || parseDollarsToMinor(tripSetAside) !== null;

  const doImport = async () => {
    if (!v1File || v1File.rows.some((r) => r.diffMinor !== 0) || !tripSetAsideValid) return;
    setBusy(true);
    setError(null);
    try {
      // One atomic transaction; the settings row (with the onboarding
      // flag) is handled inside importMigratedResult.
      await importMigratedResult(getDb(), v1File.migrated);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The import failed. Nothing was changed.");
      setBusy(false);
    }
  };

  // ---------- step navigation ----------

  const continueAccounts = () => {
    setError(null);
    try {
      buildAccounts();
      setCompletedUpTo(1);
      setScreen("fresh-payday");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check your accounts and try again.");
    }
  };

  const continuePayday = () => {
    setError(null);
    try {
      buildPayday();
      setCompletedUpTo(2);
      setScreen("fresh-bills");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check your payday and try again.");
    }
  };

  const continueBills = () => {
    setError(null);
    try {
      buildBills(buildAccounts());
      setCompletedUpTo(3);
      setScreen("fresh-goal");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check your bills and try again.");
    }
  };

  // ============================ screens ============================

  if (screen === "welcome") {
    return (
      <Shell
        title="Welcome to your money tracker."
        sub="Everything lives on this device. Pick how you want to begin."
      >
        <div className="flex flex-col gap-3">
          <button type="button" onClick={() => setScreen("migrate-info")} className="rounded-3xl bg-stone-900 px-5 py-5 text-left transition-colors hover:bg-stone-700 dark:bg-stone-100 dark:hover:bg-stone-200">
            <p className="text-base font-medium text-white dark:text-stone-900">Bring my data from the old tracker</p>
            <p className="mt-1 text-sm text-stone-300 dark:text-stone-600">
              Import your accounts, bills, and goals from your old tracker backup.
            </p>
          </button>
          <button
            type="button"
            onClick={() => setScreen("fresh-accounts")}
            className="rounded-3xl bg-white px-5 py-5 text-left ring-1 ring-inset ring-stone-200 transition-colors hover:bg-stone-50 dark:bg-stone-900 dark:ring-stone-700 dark:hover:bg-stone-800"
          >
            <p className="text-base font-medium text-stone-900 dark:text-stone-100">Start fresh</p>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
              Set up accounts, payday, bills, and a goal. About two minutes.
            </p>
          </button>
          <button
            type="button"
            onClick={() => void loadDemo()}
            disabled={busy}
            className="rounded-3xl bg-white px-5 py-5 text-left ring-1 ring-inset ring-stone-200 transition-colors hover:bg-stone-50 disabled:opacity-50 dark:bg-stone-900 dark:ring-stone-700 dark:hover:bg-stone-800"
          >
            <p className="text-base font-medium text-stone-900 dark:text-stone-100">
              {busy ? "Loading demo..." : "Load demo"}
            </p>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
              Explore with sample data first. Your real data stays untouched.
            </p>
          </button>
        </div>
        {error && <ErrorList errors={[error]} />}
        <p className="text-center text-xs text-stone-400 dark:text-stone-500">
          No account needed. Nothing is sent anywhere.
        </p>
      </Shell>
    );
  }

  if (screen === "fresh-accounts") {
    return (
      <Shell
        step="Step 1 of 5"
        title="Your accounts"
        sub="Add the accounts you want to track. For a credit card or a loan, enter what you owe as a positive number."
        onSkip={() => void skipAll()}
      >
        <div className="flex flex-col gap-3">
          {accountRows.map((row, i) => {
            const isLiability = row.type === "CreditCard" || row.type === "Loan";
            return (
              <div key={row.id} className="rounded-3xl bg-white p-4 ring-1 ring-inset ring-stone-200 dark:bg-stone-900 dark:ring-stone-700">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-stone-900 dark:text-stone-100">Account {i + 1}</p>
                  {accountRows.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setAccountRows((rows) => rows.filter((r) => r.id !== row.id))}
                      className="text-xs font-medium text-stone-500 underline decoration-stone-300 underline-offset-4 hover:text-stone-700 dark:text-stone-400 dark:decoration-stone-600"
                    >
                      Remove
                    </button>
                  )}
                </div>
                <div className="mt-3">
                  <label className={labelCls} htmlFor={`acct-name-${row.id}`}>Name</label>
                  <input
                    id={`acct-name-${row.id}`}
                    className={fieldCls}
                    value={row.name}
                    onChange={(e) =>
                      setAccountRows((rows) => rows.map((r) => (r.id === row.id ? { ...r, name: e.target.value } : r)))
                    }
                    placeholder="Checking"
                  />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelCls} htmlFor={`acct-type-${row.id}`}>Type</label>
                    <select
                      id={`acct-type-${row.id}`}
                      className={fieldCls}
                      value={row.type}
                      onChange={(e) =>
                        setAccountRows((rows) =>
                          rows.map((r) => (r.id === row.id ? { ...r, type: e.target.value as AccountType } : r)),
                        )
                      }
                    >
                      {ACCOUNT_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls} htmlFor={`acct-bal-${row.id}`}>
                      {isLiability ? "Amount owed" : "Balance"}
                    </label>
                    <input
                      id={`acct-bal-${row.id}`}
                      className={fieldCls}
                      value={row.balance}
                      onChange={(e) =>
                        setAccountRows((rows) => rows.map((r) => (r.id === row.id ? { ...r, balance: e.target.value } : r)))
                      }
                      placeholder="0.00"
                      inputMode="decimal"
                    />
                  </div>
                </div>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => setAccountRows((rows) => [...rows, { id: crypto.randomUUID(), name: "", type: "Checking", balance: "" }])}
            className="rounded-full border border-dashed border-stone-300 px-6 py-3 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-200 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800"
          >
            Add another account
          </button>
        </div>
        {error && <ErrorList errors={[error]} />}
        <button type="button" onClick={continueAccounts} className={primaryBtn}>
          Continue
        </button>
      </Shell>
    );
  }

  if (screen === "fresh-payday") {
    return (
      <Shell
        step="Step 2 of 5"
        title="Your primary payday"
        sub="This sets the rhythm for the whole app. Bills, goals, and your daily number line up behind it."
        onSkip={() => void skipAll()}
      >
        <div className="rounded-3xl bg-white p-4 ring-1 ring-inset ring-stone-200 dark:bg-stone-900 dark:ring-stone-700">
          <p className={labelCls}>How often are you paid?</p>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { id: "semi-monthly", label: "Twice a month" },
                { id: "monthly", label: "Monthly" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                aria-pressed={payday.frequency === opt.id}
                onClick={() => setPayday((p) => ({ ...p, frequency: opt.id }))}
                className={`rounded-xl px-4 py-2.5 text-sm font-medium transition-colors ${
                  payday.frequency === opt.id
                    ? "bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900"
                    : "bg-stone-100 text-stone-600 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-300 dark:hover:bg-stone-700"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="mt-3">
            <label className={labelCls} htmlFor="pay-amount">Pay amount</label>
            <input
              id="pay-amount"
              className={fieldCls}
              value={payday.amount}
              onChange={(e) => setPayday((p) => ({ ...p, amount: e.target.value }))}
              placeholder="2263.41"
              inputMode="decimal"
            />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} htmlFor="pay-date-a">
                {payday.frequency === "semi-monthly" ? "First payday" : "Next payday"}
              </label>
              <input
                id="pay-date-a"
                type="date"
                className={fieldCls}
                value={payday.dateA}
                onChange={(e) => setPayday((p) => ({ ...p, dateA: e.target.value }))}
              />
            </div>
            {payday.frequency === "semi-monthly" && (
              <div>
                <label className={labelCls} htmlFor="pay-date-b">Second payday</label>
                <input
                  id="pay-date-b"
                  type="date"
                  className={fieldCls}
                  value={payday.dateB}
                  onChange={(e) => setPayday((p) => ({ ...p, dateB: e.target.value }))}
                />
              </div>
            )}
          </div>
          <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">
            Pick today or a future date. These become your paydays going forward.
          </p>
        </div>
        {error && <ErrorList errors={[error]} />}
        <div className="flex flex-col gap-2">
          <button type="button" onClick={continuePayday} className={primaryBtn}>
            Continue
          </button>
          <button type="button" onClick={() => setScreen("fresh-accounts")} className={secondaryBtn}>
            Back
          </button>
        </div>
      </Shell>
    );
  }

  if (screen === "fresh-bills") {
    const accountOptions = accountRows.filter((r) => r.name.trim() !== "");
    return (
      <Shell
        step="Step 3 of 5"
        title="Your bills"
        sub="Add the bills that come out every month. You can add more later in the Bills tab."
        onSkip={() => void skipAll()}
      >
        <div className="flex flex-col gap-3">
          {billRows.map((row, i) => (
            <div key={row.id} className="rounded-3xl bg-white p-4 ring-1 ring-inset ring-stone-200 dark:bg-stone-900 dark:ring-stone-700">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-stone-900 dark:text-stone-100">Bill {i + 1}</p>
                {billRows.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setBillRows((rows) => rows.filter((r) => r.id !== row.id))}
                    className="text-xs font-medium text-stone-500 underline decoration-stone-300 underline-offset-4 hover:text-stone-700 dark:text-stone-400 dark:decoration-stone-600"
                  >
                    Remove
                  </button>
                )}
              </div>
              <div className="mt-3">
                <label className={labelCls} htmlFor={`bill-name-${row.id}`}>Name</label>
                <input
                  id={`bill-name-${row.id}`}
                  className={fieldCls}
                  value={row.name}
                  onChange={(e) => setBillRows((rows) => rows.map((r) => (r.id === row.id ? { ...r, name: e.target.value } : r)))}
                  placeholder="Rent"
                />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls} htmlFor={`bill-amt-${row.id}`}>Amount</label>
                  <input
                    id={`bill-amt-${row.id}`}
                    className={fieldCls}
                    value={row.amount}
                    onChange={(e) => setBillRows((rows) => rows.map((r) => (r.id === row.id ? { ...r, amount: e.target.value } : r)))}
                    placeholder="1350.00"
                    inputMode="decimal"
                  />
                </div>
                <div>
                  <label className={labelCls} htmlFor={`bill-due-${row.id}`}>Next due</label>
                  <input
                    id={`bill-due-${row.id}`}
                    type="date"
                    className={fieldCls}
                    value={row.dueDate}
                    onChange={(e) => setBillRows((rows) => rows.map((r) => (r.id === row.id ? { ...r, dueDate: e.target.value } : r)))}
                  />
                </div>
              </div>
              <div className="mt-3">
                <label className={labelCls} htmlFor={`bill-acct-${row.id}`}>Paid from</label>
                <select
                  id={`bill-acct-${row.id}`}
                  className={fieldCls}
                  value={accountOptions.some((a) => a.id === row.accountId) ? row.accountId : accountOptions[0]?.id ?? ""}
                  onChange={(e) => setBillRows((rows) => rows.map((r) => (r.id === row.id ? { ...r, accountId: e.target.value } : r)))}
                >
                  {accountOptions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              setBillRows((rows) => [
                ...rows,
                { id: crypto.randomUUID(), name: "", amount: "", dueDate: nextDomOnOrAfter(todayLocal(), 1), accountId: "" },
              ])
            }
            className="rounded-full border border-dashed border-stone-300 px-6 py-3 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-200 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800"
          >
            Add another bill
          </button>
        </div>
        {error && <ErrorList errors={[error]} />}
        <div className="flex flex-col gap-2">
          <button type="button" onClick={continueBills} className={primaryBtn}>
            Continue
          </button>
          <button type="button" onClick={() => setScreen("fresh-payday")} className={secondaryBtn}>
            Back
          </button>
        </div>
      </Shell>
    );
  }

  if (screen === "fresh-goal") {
    return (
      <Shell
        step="Step 4 of 5"
        title="Set a goal"
        sub="Optional. Something you are saving for, like an emergency fund or a trip. You can change it anytime."
        onSkip={() => void skipAll()}
      >
        <div className="rounded-3xl bg-white p-4 ring-1 ring-inset ring-stone-200 dark:bg-stone-900 dark:ring-stone-700">
          <div>
            <label className={labelCls} htmlFor="goal-name">Goal name</label>
            <input
              id="goal-name"
              className={fieldCls}
              value={goal.name}
              onChange={(e) => setGoal((g) => ({ ...g, name: e.target.value }))}
              placeholder="Emergency fund"
            />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} htmlFor="goal-target">Target amount</label>
              <input
                id="goal-target"
                className={fieldCls}
                value={goal.target}
                onChange={(e) => setGoal((g) => ({ ...g, target: e.target.value }))}
                placeholder="10000"
                inputMode="decimal"
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="goal-date">Target date (optional)</label>
              <input
                id="goal-date"
                type="date"
                className={fieldCls}
                value={goal.targetDate}
                onChange={(e) => setGoal((g) => ({ ...g, targetDate: e.target.value }))}
              />
            </div>
          </div>
        </div>
        {error && <ErrorList errors={[error]} />}
        <div className="flex flex-col gap-2">
          <button type="button" onClick={() => void finishFresh()} disabled={busy} className={primaryBtn}>
            {busy ? "Setting things up..." : "See my daily number"}
          </button>
          <button type="button" onClick={() => setScreen("fresh-bills")} className={secondaryBtn}>
            Back
          </button>
        </div>
      </Shell>
    );
  }

  if (screen === "fresh-reveal") {
    const currency = reveal?.currency ?? "USD";
    const state = reveal?.state;
    const isDeficit = state?.result.mode === "deficit";
    return (
      <Shell step="Step 5 of 5" title="Your daily number">
        {state ? (
          isDeficit ? (
            <div className="rounded-3xl bg-white p-6 ring-1 ring-inset ring-stone-200 dark:bg-stone-900 dark:ring-stone-700">
              <p className="text-sm text-stone-600 dark:text-stone-400">
                Bills and goals come to{" "}
                <span className="font-semibold text-stone-900 dark:text-stone-100">
                  {formatMoney(state.result.shortfall ?? 0, currency)}
                </span>{" "}
                more than what is available before payday. Pause a goal or move a bill to close the gap.
              </p>
            </div>
          ) : (
            <div className="rounded-3xl bg-white p-6 ring-1 ring-inset ring-stone-200 dark:bg-stone-900 dark:ring-stone-700">
              <p className="font-display text-7xl leading-none tracking-tight text-stone-900 dark:text-stone-100">
                {formatWhole(state.snapshot.startOfDayAmount, currency)}
              </p>
              <p className="mt-4 text-sm text-stone-600 dark:text-stone-400">
                This is what you can spend each day until payday. It updates every morning.
              </p>
              <div className="mt-4 flex items-baseline justify-between border-t border-stone-100 pt-4 dark:border-stone-800">
                <p className="text-sm text-stone-600 dark:text-stone-400">
                  <span className="font-semibold text-stone-900 dark:text-stone-100">
                    {formatMoney(state.leftToday, currency)}
                  </span>{" "}
                  left today
                </p>
                <p className="text-sm text-stone-500 dark:text-stone-400">
                  {state.cycleDaysLeft} day{state.cycleDaysLeft === 1 ? "" : "s"} until payday
                </p>
              </div>
            </div>
          )
        ) : (
          <div className="rounded-3xl bg-white p-6 ring-1 ring-inset ring-stone-200 dark:bg-stone-900 dark:ring-stone-700">
            <p className="text-sm text-stone-600 dark:text-stone-400">Your number is being calculated...</p>
          </div>
        )}
        {error && <ErrorList errors={[error]} />}
        <button type="button" onClick={() => void enterApp()} disabled={busy} className={primaryBtn}>
          {busy ? "One moment..." : "Enter the app"}
        </button>
      </Shell>
    );
  }

  if (screen === "migrate-info") {
    return (
      <Shell
        title="Bring your data over"
        sub="Three quick steps. Nothing leaves this device. The backup is read on your phone and nothing is uploaded anywhere."
      >
        <ol className="flex flex-col gap-3">
          {[
            "Open the old tracker on your phone.",
            "Open its export screen and download the JSON backup.",
            "Come back here and upload the file.",
          ].map((text, i) => (
            <li
              key={i}
              className="flex items-start gap-3 rounded-3xl bg-white px-5 py-4 ring-1 ring-inset ring-stone-200 dark:bg-stone-900 dark:ring-stone-700"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-stone-900 text-sm font-medium text-white dark:bg-stone-100 dark:text-stone-900">
                {i + 1}
              </span>
              <p className="pt-1 text-sm text-stone-700 dark:text-stone-200">{text}</p>
            </li>
          ))}
        </ol>
        <div className="flex flex-col gap-2">
          <button type="button" onClick={() => setScreen("migrate-upload")} className={primaryBtn}>
            Continue
          </button>
          <button type="button" onClick={() => setScreen("welcome")} className={secondaryBtn}>
            Back
          </button>
        </div>
      </Shell>
    );
  }

  if (screen === "migrate-upload") {
    return (
      <Shell
        title="Upload your backup"
        sub="Choose the JSON file you downloaded from the old tracker."
      >
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          aria-label="Choose your v1 backup file"
          onChange={(e) => void pickFile(e.target.files?.[0])}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="flex w-full flex-col items-center gap-2 rounded-3xl border border-dashed border-stone-300 bg-white px-6 py-10 text-center transition-colors hover:bg-stone-50 disabled:opacity-50 dark:border-stone-600 dark:bg-stone-900 dark:hover:bg-stone-800"
        >
          <p className="text-base font-medium text-stone-900 dark:text-stone-100">
            {busy ? "Reading the file..." : fileName || "Choose file"}
          </p>
          <p className="text-sm text-stone-500 dark:text-stone-400">
            {fileName ? "Reading it now. Nothing has been imported yet." : "The file ends in .json"}
          </p>
        </button>
        <ErrorList errors={v1Errors} />
        {v1Errors.length > 0 && (
          <button type="button" onClick={tryDifferentFile} className={secondaryBtn}>
            Try a different file
          </button>
        )}
        <button type="button" onClick={() => setScreen("migrate-info")} className={secondaryBtn}>
          Back
        </button>
      </Shell>
    );
  }

  // migrate-review
  const rows = v1File?.rows ?? [];
  const anyDiff = rows.some((r) => r.diffMinor !== 0);
  const tripExpenses = v1File?.v1.trip_expenses ?? [];
  const tripGoal = v1File?.migrated.goals.find((g) => g.name === "LA trip float") ?? null;
  const tripSetAsideTx = tripGoal
    ? (v1File?.migrated.transactions.find((t) => t.type === "Transfer" && t.goalId === tripGoal.id) ?? null)
    : null;
  const tripSetAsideAccount = tripSetAsideTx
    ? (v1File?.migrated.accounts.find((a) => a.id === tripSetAsideTx.accountId) ?? null)
    : null;
  return (
    <Shell
      title="Check the numbers"
      sub="This is what the old tracker said, and what the new one will store. Every row must match before anything is imported."
    >
      <div className="overflow-hidden rounded-3xl bg-white ring-1 ring-inset ring-stone-200 dark:bg-stone-900 dark:ring-stone-700">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone-100 dark:border-stone-800">
              <th className="px-4 py-3 text-left text-xs font-medium text-stone-500 dark:text-stone-400">Account</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-stone-500 dark:text-stone-400">Old tracker</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-stone-500 dark:text-stone-400">New tracker</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-stone-500 dark:text-stone-400">Diff</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-stone-100 last:border-0 dark:border-stone-800">
                <td className="px-4 py-3 font-medium text-stone-900 dark:text-stone-100">{r.label}</td>
                <td className="px-4 py-3 text-right tabular-nums text-stone-600 dark:text-stone-300">
                  {formatMoney(r.v1Minor, "USD")}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-stone-600 dark:text-stone-300">
                  {formatMoney(r.v2Minor, "USD")}
                </td>
                <td
                  className={`px-4 py-3 text-right tabular-nums ${
                    r.diffMinor === 0
                      ? "text-stone-400 dark:text-stone-500"
                      : "font-semibold text-red-700 dark:text-red-300"
                  }`}
                >
                  {r.diffMinor === 0 ? "Matches" : formatMoney(r.diffMinor, "USD")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {tripExpenses.length > 0 && (
        <div className="rounded-3xl bg-white p-4 ring-1 ring-inset ring-stone-200 dark:bg-stone-900 dark:ring-stone-700">
          <p className="text-sm font-medium text-stone-900 dark:text-stone-100">LA trip float</p>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
            Your old tracker had {tripExpenses.length} trip {tripExpenses.length === 1 ? "entry" : "entries"}.
            The new tracker saves toward a fixed $570 goal for the trip. What you already spent does not raise it.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} htmlFor="trip-leave">
                Day you leave (optional)
              </label>
              <input
                id="trip-leave"
                type="date"
                className={fieldCls}
                value={tripLeaveDate}
                onChange={(e) => onTripFieldChange(e.target.value, tripSetAside)}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="trip-setaside">
                Already set aside ($)
              </label>
              <input
                id="trip-setaside"
                className={fieldCls}
                value={tripSetAside}
                onChange={(e) => onTripFieldChange(tripLeaveDate, e.target.value)}
                placeholder="0.00"
                inputMode="decimal"
              />
            </div>
          </div>
          {!tripSetAsideValid && (
            <p className="mt-2 text-xs text-red-700 dark:text-red-300">
              Enter an amount like 570 or 570.00.
            </p>
          )}
        </div>
      )}
      {v1File && v1File.warnings.length > 0 && (
        <div className="rounded-2xl bg-amber-50 px-4 py-3 ring-1 ring-inset ring-amber-200 dark:bg-amber-950/40 dark:ring-amber-900">
          <p className="text-sm text-amber-800 dark:text-amber-200">
            Note: {v1File.warnings.length} old {v1File.warnings.length === 1 ? "entry" : "entries"} had a bad date and{" "}
            {v1File.warnings.length === 1 ? "was" : "were"} skipped. Everything else will import.
          </p>
        </div>
      )}
      {tripGoal && (
        <div className="rounded-2xl bg-stone-50 px-4 py-3 ring-1 ring-inset ring-stone-200 dark:bg-stone-900 dark:ring-stone-700">
          <p className="text-sm text-stone-700 dark:text-stone-200">
            LA trip: goal {formatMoney(tripGoal.targetAmount, "USD")}, due {tripGoal.targetDate ?? "no date set"},{" "}
            {formatMoney(tripSetAsideTx?.amount ?? 0, "USD")} already earmarked
            {tripSetAsideAccount ? ` in ${tripSetAsideAccount.name}` : ""}.
          </p>
        </div>
      )}
      {anyDiff ? (
        <>
          <div className="rounded-2xl bg-red-50 px-4 py-3 ring-1 ring-inset ring-red-200 dark:bg-red-950/40 dark:ring-red-900">
            <p className="text-sm text-red-800 dark:text-red-200">
              These do not line up, so nothing was imported. Download a fresh backup from the old tracker and try again.
            </p>
          </div>
          <button type="button" onClick={tryDifferentFile} className={primaryBtn}>
            Try a different file
          </button>
        </>
      ) : (
        <>
          {error && <ErrorList errors={[error]} />}
          <button type="button" onClick={() => void doImport()} disabled={busy || !tripSetAsideValid} className={primaryBtn}>
            {busy ? "Importing..." : "Import everything"}
          </button>
          <button type="button" onClick={tryDifferentFile} className={secondaryBtn}>
            Try a different file
          </button>
        </>
      )}
    </Shell>
  );
}

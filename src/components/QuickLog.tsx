/**
 * Quick-log: a floating action button that opens a bottom sheet for
 * one-tap Expense / Income / Transfer entries. Persists through the
 * quickLog app layer; the parent reloads everything after a save.
 *
 * Speed features: payee autocomplete (completions dropdown + blur
 * prefill that never clobbers manually-touched fields), last-used
 * account preselected on open, "n" keyboard shortcut, and bill-payment
 * matching that offers to settle a Scheduled bill in place instead of
 * double-counting it.
 */
import { useEffect, useState } from "react";
import { createRepositories } from "../data/repositories/index.js";
import { getActiveDb, isDemoMode } from "../data/db.js";
import {
  findBillMatch,
  parseDollarsToMinor,
  payeeCompletions,
  saveQuickLog,
  suggestPayee,
} from "../app/quickLog.js";
import type { QuickLogInput } from "../app/quickLog.js";
import { formatMoney } from "../app/format.js";
import { makeConverter } from "../app/dashboard.js";
import { isDateOnly, todayLocal } from "../domain/dates/dateOnly.js";
import type { DateOnly } from "../domain/dates/dateOnly.js";
import type { Account } from "../domain/entities/account.js";
import type { Category } from "../domain/entities/category.js";
import type { Goal } from "../domain/entities/goal.js";
import type { Transaction } from "../domain/entities/transaction.js";
import { earmarkedInSpendable } from "../domain/engine/goals.js";
import {
  defaultTransactionToBase,
  type TransactionToBase,
} from "../domain/engine/safeToSpend.js";
import {
  attachExpenseToReimbursement,
  findOpenReimbursementSplit,
  getOrCreateReimbursementSplit,
} from "../app/reimbursement.js";
import { FxRateMemory } from "../domain/money/fx.js";
import type { MinorUnits } from "../domain/money/money.js";

type QuickType = "Expense" | "Income" | "Transfer";

const TYPES: QuickType[] = ["Expense", "Income", "Transfer"];

const LAST_ACCOUNT_KEY = "mtv2-last-account";

const fieldCls =
  "w-full rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-3.5 py-2.5 text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 focus:border-stone-400 dark:focus:border-stone-500 focus:outline-none";
const labelCls = "mb-1.5 block text-xs font-medium text-stone-500 dark:text-stone-400";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const prettyDate = (d: DateOnly): string =>
  `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}`;

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
        checked ? "bg-stone-900 dark:bg-stone-100" : "bg-stone-300 dark:bg-stone-600"
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white dark:bg-stone-900 shadow transition-all ${
          checked ? "left-[22px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

/**
 * Earmarked funds per goal id, converted to the user's base currency.
 * Mirrors the dashboard's conversion path (account fxRateToBase, then
 * remembered rates, then pass-through), so the picker shows the same
 * numbers the Goals tab does.
 */
function earmarkedByGoal(
  goals: Goal[],
  transactions: Transaction[],
  accounts: Account[],
  baseCurrency: string,
  fxRates: Record<string, number>,
): Map<string, MinorUnits> {
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const fxMemory = new FxRateMemory();
  for (const [pair, rate] of Object.entries(fxRates)) {
    const [from, to] = pair.split("->");
    if (from && to) fxMemory.setRate(from, to, rate);
  }
  const convertToBase = makeConverter(baseCurrency, fxMemory, () => {
    // No visible FX warnings in this sheet; same pass-through behavior
    // as the dashboard.
  });
  const accountCurrencyOf = (id: string): string =>
    accountsById.get(id)?.currency ?? baseCurrency;
  const txToBase: TransactionToBase = defaultTransactionToBase(
    accountCurrencyOf,
    convertToBase,
  );
  const out = new Map<string, MinorUnits>();
  for (const g of goals) {
    out.set(g.id, earmarkedInSpendable(g.id, transactions, accountsById, txToBase));
  }
  return out;
}

/**
 * Deep-link prefill: when the App hands Quick-Log a prefill (from a
 * ?add= link), the sheet opens once with those values. The normal Save
 * path runs unchanged — bill matching, duplicate checks, and per-currency
 * amount validation all still apply. Nothing saves until the user taps
 * Save. onPrefillConsumed fires right after the sheet opens so the App
 * can clear the prefill and re-renders never reopen it.
 */
export interface QuickLogPrefill {
  type: "Expense" | "Income";
  amount: string;
  payee: string;
  accountId: string;
  date: DateOnly;
  /**
   * When the prefill came from a private-inbox entry, its id. Reported
   * back through onInboxEntrySaved when the entry is saved, so the App
   * can mark it applied exactly once. Dismissing without saving clears
   * it — the entry stays pending.
   */
  inboxEntryId?: string;
}

export function QuickLog({
  onSaved,
  prefill,
  onPrefillConsumed,
  onInboxEntrySaved,
}: {
  onSaved: () => void;
  prefill?: QuickLogPrefill | null;
  onPrefillConsumed?: () => void;
  onInboxEntrySaved?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [baseCurrency, setBaseCurrency] = useState("USD");
  const [lastUsedFxRates, setLastUsedFxRates] = useState<Record<string, number>>({});
  // "Paid from goal": "" means none selected.
  const [paidFromGoalId, setPaidFromGoalId] = useState("");
  // "Reimbursable": attaches the expense to the LA trip reimbursement IOU.
  const [reimbursable, setReimbursable] = useState(false);
  const [type, setType] = useState<QuickType>("Expense");
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [toAccountId, setToAccountId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [payee, setPayee] = useState("");
  const [date, setDate] = useState<DateOnly>(todayLocal());
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  // Inbox entry id for the current open session: set when the sheet opens
  // from an inbox prefill, reported on save, cleared on close.
  const [activeInboxEntryId, setActiveInboxEntryId] = useState<string | null>(null);
  // Touched flags: blur prefill never clobbers fields the user set manually.
  const [touchedAccount, setTouchedAccount] = useState(false);
  const [touchedCategory, setTouchedCategory] = useState(false);
  // Bill-match confirmation state.
  const [pendingBill, setPendingBill] = useState<Transaction | null>(null);
  const [billDeclined, setBillDeclined] = useState(false);

  const demo = isDemoMode();

  const openSheet = async (pf?: QuickLogPrefill | null) => {
    const repos = createRepositories(getActiveDb());
    const [accts, cats, txs, goalRows, settings] = await Promise.all([
      repos.accounts.active(),
      repos.categories.getAll(),
      repos.transactions.getAll(),
      repos.goals.getAll(),
      repos.settings.get(),
    ]);
    const live = cats.filter((c) => !c.archived);
    setAccounts(accts);
    setCategories(live);
    setTransactions(txs);
    setGoals(goalRows);
    setBaseCurrency(settings?.baseCurrency ?? "USD");
    setLastUsedFxRates(settings?.lastUsedFxRates ?? {});
    setPaidFromGoalId("");
    setReimbursable(false);
    const entryType = pf?.type ?? "Expense";
    setType(entryType);
    setAmount(pf?.amount ?? "");
    let initialAccount = accts[0]?.id ?? "";
    if (pf?.accountId && accts.some((a) => a.id === pf.accountId)) {
      // Deep-link prefill wins over the last-used account.
      initialAccount = pf.accountId;
    } else {
      try {
        const last = window.localStorage.getItem(LAST_ACCOUNT_KEY);
        if (last && accts.some((a) => a.id === last)) initialAccount = last;
      } catch {
        // storage unavailable; fall back to the first account
      }
    }
    setAccountId(initialAccount);
    setToAccountId("");
    setPayee(pf?.payee ?? "");
    setDate(pf?.date ?? todayLocal());
    const defaultKind = entryType === "Income" ? "income" : "expense";
    setCategoryId(live.find((c) => c.kind === defaultKind)?.id ?? "");
    setError(null);
    setSaved(false);
    setSaving(false);
    setTouchedAccount(false);
    setTouchedCategory(false);
    setPendingBill(null);
    setBillDeclined(false);
    setActiveInboxEntryId(pf?.inboxEntryId ?? null);
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setError(null);
    setSaved(false);
    setPendingBill(null);
    setActiveInboxEntryId(null);
  };

  // Deep-link prefill: when the App hands us a prefill, open the sheet
  // once with those values, then tell the App it was consumed so later
  // re-renders never reopen it. openSheet only touches state setters
  // (stable), so omitting it from deps is safe.
  useEffect(() => {
    if (prefill) {
      void openSheet(prefill);
      onPrefillConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  // "n" opens the sheet. Ignored inside editable fields, with any modifier
  // key held, or when the sheet is already open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "n" && e.key !== "N") return;
      if (open) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const el = e.target as HTMLElement | null;
      if (el) {
        const tag = el.tagName.toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select") return;
        if (el.isContentEditable) return;
      }
      void openSheet();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open ]);

  const switchType = (t: QuickType) => {
    setType(t);
    // Goal tagging and reimbursement are Expense-only; switching away
    // clears both.
    if (t !== "Expense") {
      setPaidFromGoalId("");
      setReimbursable(false);
    }
    if (t !== "Transfer") {
      const kind = t === "Expense" ? "expense" : "income";
      setCategoryId(categories.find((c) => c.kind === kind)?.id ?? "");
    }
  };

  const visibleCategories = categories.filter((c) =>
    type === "Expense" ? c.kind === "expense" : c.kind === "income",
  );

  /** Fill payee plus that payee's usual category/account (clicking a completion). */
  const applyPayeeCompletion = (completion: string) => {
    setPayee(completion);
    const s = suggestPayee(transactions, completion);
    if (!s) return;
    if (s.categoryId && visibleCategories.some((c) => c.id === s.categoryId)) {
      setCategoryId(s.categoryId);
    }
    if (accounts.some((a) => a.id === s.accountId)) {
      setAccountId(s.accountId);
    }
  };

  /**
   * On blur, if the typed payee exactly matches a past payee, prefill its
   * usual category/account — but only for fields the user has not changed
   * manually in this session.
   */
  const onPayeeBlur = () => {
    const needle = payee.trim().toLowerCase();
    if (needle === "") return;
    const exact = transactions.some((t) => t.payee.trim().toLowerCase() === needle);
    if (!exact) return;
    const s = suggestPayee(transactions, payee);
    if (!s) return;
    if (
      !touchedCategory &&
      s.categoryId &&
      visibleCategories.some((c) => c.id === s.categoryId)
    ) {
      setCategoryId(s.categoryId);
    }
    if (!touchedAccount && accounts.some((a) => a.id === s.accountId)) {
      setAccountId(s.accountId);
    }
  };

  const completions = payeeCompletions(transactions, payee);

  const buildInput = (minor: number): QuickLogInput => ({
    type,
    amountMinor: minor,
    accountId,
    ...(type === "Transfer" ? { toAccountId } : {}),
    categoryId: type === "Transfer" ? null : categoryId || null,
    payee: payee.trim(),
    date: isDateOnly(date) ? date : todayLocal(),
    // Goal tagging is Expense-only; the settle path strips it explicitly.
    ...(type === "Expense" && paidFromGoalId !== "" ? { goalId: paidFromGoalId } : {}),
  });

  // Goals with money still set aside, in base currency. Only these can
  // fund a "paid from goal" entry.
  const earmarked = earmarkedByGoal(goals, transactions, accounts, baseCurrency, lastUsedFxRates);
  const eligibleGoals = goals.filter((g) => (earmarked.get(g.id) ?? 0) > 0);

  const persist = async (
    repos: ReturnType<typeof createRepositories>,
    input: QuickLogInput,
  ) => {
    // Reimbursable trip expense: validate the IOU currency BEFORE saving,
    // so a mismatch fails loud instead of saving an unattached expense.
    const wantReimburse = reimbursable && input.type === "Expense";
    if (wantReimburse) {
      const acct =
        accounts.find((a) => a.id === input.accountId) ??
        (await repos.accounts.getById(input.accountId));
      const currency = acct?.currency;
      if (!currency) throw new Error("Pick an account.");
      const open = findOpenReimbursementSplit(await repos.splits.getAll());
      if (open && open.currency !== currency) {
        throw new Error(
          `The reimbursement IOU is in ${open.currency} — this expense is in ${currency}, so it can't be added.`,
        );
      }
    }
    const { transaction } = await saveQuickLog(repos, input);
    if (wantReimburse) {
      const nowIso = new Date().toISOString();
      const split = await getOrCreateReimbursementSplit(
        repos,
        transaction.currency,
        nowIso,
      );
      await attachExpenseToReimbursement(repos, split.id, transaction);
    }
    try {
      window.localStorage.setItem(LAST_ACCOUNT_KEY, input.accountId);
    } catch {
      // storage unavailable; the save itself still succeeded
    }
    setSaved(true);
    if (activeInboxEntryId) {
      onInboxEntrySaved?.(activeInboxEntryId);
      setActiveInboxEntryId(null);
    }
    window.setTimeout(() => {
      close();
      onSaved();
    }, 900);
  };

  const save = async (opts?: { skipBillCheck?: boolean }) => {
    setError(null);
    const account = accounts.find((a) => a.id === accountId);
    if (!account) {
      setError("Pick an account.");
      return;
    }
    const minor = parseDollarsToMinor(amount, account.currency);
    if (minor === null) {
      setError("Enter an amount like 12.34");
      return;
    }
    if (type === "Transfer" && !toAccountId) {
      setError("Pick the destination account.");
      return;
    }
    setSaving(true);
    try {
      const repos = createRepositories(getActiveDb());
      const input = buildInput(minor);
      if (type === "Expense" && !billDeclined && !opts?.skipBillCheck) {
        const txs = await repos.transactions.getAll();
        setTransactions(txs);
        const match = findBillMatch(txs, {
          payee: input.payee,
          amountMinor: minor,
          date: input.date,
        });
        if (match) {
          setPendingBill(match.transaction);
          setSaving(false);
          return;
        }
      }
      await persist(repos, input);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
      setSaving(false);
    }
  };

  /** "Yes, settle it": settle the matched Scheduled bill in place. */
  const settleBill = async () => {
    if (!pendingBill) return;
    setError(null);
    const account = accounts.find((a) => a.id === accountId);
    const minor = account ? parseDollarsToMinor(amount, account.currency) : null;
    if (!account || minor === null) {
      setError("Enter an amount like 12.34");
      return;
    }
    setSaving(true);
    try {
      const repos = createRepositories(getActiveDb());
      // The settle path is untouched by goal tagging: settling a bill in
      // place keeps the entry exactly as before.
      await persist(repos, {
        ...buildInput(minor),
        settleScheduledId: pendingBill.id,
        goalId: undefined,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
      setSaving(false);
    }
  };

  /** "No, new expense": save normally, skipping the bill check. */
  const declineBill = () => {
    setPendingBill(null);
    setBillDeclined(true);
    void save({ skipBillCheck: true });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void openSheet()}
        aria-label="Quick log"
        className="fixed bottom-24 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-stone-900 dark:bg-stone-100 text-3xl font-light leading-none text-white dark:text-stone-900 shadow-lg transition-transform active:scale-95"
      >
        +
      </button>

      {open && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className="absolute inset-0 bg-black/40"
          />
          <div className="absolute bottom-0 inset-x-0 mx-auto max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white dark:bg-stone-900 p-5 pb-8">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2">
                <h2 className="font-display text-xl text-stone-900 dark:text-stone-100">Quick log</h2>
                {demo && (
                  <span className="rounded-full bg-stone-900 dark:bg-stone-100 px-2.5 py-0.5 text-[11px] font-semibold tracking-wide text-white dark:text-stone-900">
                    DEMO
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close quick log"
                className="flex h-8 w-8 items-center justify-center rounded-full text-lg text-stone-500 dark:text-stone-400 transition-colors hover:bg-stone-100 dark:hover:bg-stone-800"
              >
                ×
              </button>
            </div>

            <div className="mt-4 flex flex-col gap-4">
              <div
                className="flex rounded-full bg-stone-100 dark:bg-stone-800 p-1"
                role="group"
                aria-label="Entry type"
              >
                {TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => switchType(t)}
                    className={`flex-1 rounded-full py-2 text-sm font-medium transition-colors ${
                      type === t
                        ? "bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-sm"
                        : "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>

              <div>
                <label htmlFor="ql-amount" className={labelCls}>
                  Amount
                </label>
                <input
                  id="ql-amount"
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className={`${fieldCls} font-display text-2xl`}
                />
              </div>

              <div>
                <label htmlFor="ql-account" className={labelCls}>
                  Account
                </label>
                <select
                  id="ql-account"
                  value={accountId}
                  onChange={(e) => {
                    setAccountId(e.target.value);
                    setTouchedAccount(true);
                  }}
                  className={fieldCls}
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>

              {type === "Transfer" && (
                <div>
                  <label htmlFor="ql-to-account" className={labelCls}>
                    To account
                  </label>
                  <select
                    id="ql-to-account"
                    value={toAccountId}
                    onChange={(e) => setToAccountId(e.target.value)}
                    className={fieldCls}
                  >
                    <option value="">Choose…</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {type !== "Transfer" && (
                <div>
                  <label htmlFor="ql-category" className={labelCls}>
                    Category
                  </label>
                  <select
                    id="ql-category"
                    value={categoryId}
                    onChange={(e) => {
                      setCategoryId(e.target.value);
                      setTouchedCategory(true);
                    }}
                    className={fieldCls}
                  >
                    {visibleCategories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="relative">
                <label htmlFor="ql-payee" className={labelCls}>
                  Payee
                </label>
                <input
                  id="ql-payee"
                  type="text"
                  placeholder="Who or what"
                  value={payee}
                  onChange={(e) => setPayee(e.target.value)}
                  onBlur={onPayeeBlur}
                  autoComplete="off"
                  className={fieldCls}
                />
                {completions.length > 0 && !saved && (
                  <ul className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 shadow-lg">
                    {completions.map((c) => (
                      <li key={c}>
                        <button
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            applyPayeeCompletion(c);
                          }}
                          className="block w-full px-3.5 py-2.5 text-left text-sm text-stone-900 dark:text-stone-100 transition-colors hover:bg-stone-100 dark:hover:bg-stone-800"
                        >
                          {c}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <label htmlFor="ql-date" className={labelCls}>
                  Date
                </label>
                <input
                  id="ql-date"
                  type="date"
                  value={date}
                  onChange={(e) =>
                    setDate(isDateOnly(e.target.value) ? e.target.value : todayLocal())
                  }
                  className={fieldCls}
                />
              </div>

              {type === "Expense" && !pendingBill && eligibleGoals.length > 0 && (
                <div>
                  <label htmlFor="ql-goal" className={labelCls}>
                    Paid from goal
                  </label>
                  <select
                    id="ql-goal"
                    value={paidFromGoalId}
                    onChange={(e) => setPaidFromGoalId(e.target.value)}
                    className={fieldCls}
                  >
                    <option value="">None</option>
                    {eligibleGoals.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name} ({formatMoney(earmarked.get(g.id) ?? 0, baseCurrency)} set aside)
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {type === "Expense" && !pendingBill && (
                <div className="flex items-center justify-between rounded-2xl bg-stone-50 dark:bg-stone-800 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
                      Reimbursable
                    </p>
                    <p className="text-xs text-stone-500 dark:text-stone-400">
                      Adds it to the LA trip reimbursement IOU.
                    </p>
                  </div>
                  <Toggle
                    checked={reimbursable}
                    onChange={setReimbursable}
                    label="Reimbursable"
                  />
                </div>
              )}

              {error && <p className="text-sm font-medium text-red-700 dark:text-red-300">{error}</p>}
              {saved && (
                <p className="text-center text-sm font-medium text-emerald-700 dark:text-emerald-300">
                  {demo ? "Saved to demo data." : "Saved."}
                </p>
              )}

              {pendingBill ? (
                <div className="rounded-2xl border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800 p-4">
                  <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
                    Is this your {pendingBill.payee} bill?
                  </p>
                  <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
                    {formatMoney(pendingBill.amount, pendingBill.currency)} · due{" "}
                    {prettyDate(pendingBill.date)}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => void settleBill()}
                      disabled={saving}
                      className="flex-1 rounded-full bg-stone-900 dark:bg-stone-100 py-2.5 text-sm font-medium text-white dark:text-stone-900 transition-colors hover:bg-stone-700 dark:hover:bg-stone-200 disabled:opacity-60"
                    >
                      {saving ? "Saving…" : "Yes, settle it"}
                    </button>
                    <button
                      type="button"
                      onClick={declineBill}
                      disabled={saving}
                      className="flex-1 rounded-full border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 py-2.5 text-sm font-medium text-stone-700 dark:text-stone-300 transition-colors hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-60"
                    >
                      No, new expense
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving || saved}
                  className="rounded-full bg-stone-900 dark:bg-stone-100 py-3 text-sm font-medium text-white dark:text-stone-900 transition-colors hover:bg-stone-700 dark:hover:bg-stone-200 disabled:opacity-60"
                >
                  {saving && !saved ? "Saving…" : demo ? "Save to demo" : "Save"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

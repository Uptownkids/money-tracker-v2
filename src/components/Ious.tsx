/**
 * IOUs: list open splits (money owed to / by Malike), with a create sheet
 * (link an expense or standalone) and a settle sheet. Settling records the
 * money movement — a refund against the linked expense, a money-in for a
 * standalone IOU, or a payment for one Malike owes — or settles without
 * recording when the money is already logged elsewhere.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRepositories } from "../data/repositories/index.js";
import { getActiveDb } from "../data/db.js";
import type { Split, IouDirection } from "../domain/entities/split.js";
import type { Transaction } from "../domain/entities/transaction.js";
import type { Account } from "../domain/entities/account.js";
import {
  buildSettlementTransaction,
  countedIouTotal,
  settleIou,
} from "../domain/engine/ious.js";
import {
  isReimbursementSplit,
  linkedReimbursementExpenses,
  settleReimbursement,
} from "../app/reimbursement.js";
import { parseDollarsToMinor } from "../app/quickLog.js";
import { formatMoney } from "../app/format.js";
import { decimalsOf } from "../domain/money/currency.js";
import { todayLocal, addDays, type DateOnly } from "../domain/dates/dateOnly.js";
import { resolvePayCycle } from "../domain/dates/payCycle.js";
import { sumMinor, type MinorUnits } from "../domain/money/money.js";

const fieldCls =
  "w-full rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-3.5 py-2.5 text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 focus:border-stone-400 dark:focus:border-stone-500 focus:outline-none";
const labelCls = "mb-1.5 block text-xs font-medium text-stone-500 dark:text-stone-400";

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

function formatExpectedBy(expectedBy?: DateOnly): string {
  if (!expectedBy) return "No date";
  const parts = expectedBy.split("-").map(Number);
  const y = parts[0] ?? 0;
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Expandable receipt list for the reimbursement IOU: the running total
 * plus every linked expense, so receipts can be matched line by line.
 */
function ReceiptsExpander({
  split,
  transactions,
  expanded,
  onToggle,
}: {
  split: Split;
  transactions: Transaction[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const receipts = linkedReimbursementExpenses(transactions, split.id);
  const total = sumMinor(receipts.map((t) => t.amount));
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between rounded-xl bg-stone-50 dark:bg-stone-800 px-3 py-2 text-xs text-stone-600 dark:text-stone-400 transition-colors hover:bg-stone-100 dark:hover:bg-stone-700"
      >
        <span>
          {receipts.length} {receipts.length === 1 ? "receipt" : "receipts"} ·{" "}
          {formatMoney(total, split.currency)}
        </span>
        <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <ul className="mt-1 divide-y divide-stone-100 dark:divide-stone-800 rounded-xl ring-1 ring-inset ring-stone-200 dark:ring-stone-700">
          {receipts.length === 0 ? (
            <li className="px-3 py-2.5 text-xs text-stone-500 dark:text-stone-400">
              No receipts yet — toggle Reimbursable on a trip expense in
              Quick-Log.
            </li>
          ) : (
            receipts.map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between gap-2 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-stone-900 dark:text-stone-100">
                    {t.payee || "Expense"}
                  </p>
                  <p className="text-[11px] text-stone-500 dark:text-stone-400">
                    {t.date}
                  </p>
                </div>
                <p className="shrink-0 text-xs font-medium text-stone-900 dark:text-stone-100">
                  {formatMoney(t.amount, t.currency)}
                </p>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

function DirectionBadge({ direction }: { direction: IouDirection }) {
  const owedToMalike = direction === "TheyOweMe";
  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${
        owedToMalike
          ? "bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900"
          : "bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-400"
      }`}
    >
      {owedToMalike ? "Owes you" : "You owe"}
    </span>
  );
}

function CreateIouSheet({
  transactions,
  baseCurrency,
  onClose,
  onSaved,
}: {
  transactions: Transaction[];
  baseCurrency: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"linked" | "standalone">("standalone");
  const [linkedId, setLinkedId] = useState<string>("");
  const [person, setPerson] = useState("");
  const [amountText, setAmountText] = useState("");
  const [direction, setDirection] = useState<IouDirection>("TheyOweMe");
  const [expectedBy, setExpectedBy] = useState("");
  const [countOnIt, setCountOnIt] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const linkedTx = linkedId
    ? transactions.find((t) => t.id === linkedId)
    : undefined;

  const chooseLinked = (id: string) => {
    setLinkedId(id);
    const tx = transactions.find((t) => t.id === id);
    if (tx) {
      setAmountText((tx.amount / 10 ** decimalsOf(tx.currency)).toString());
    }
  };

  const save = async () => {
    setError(null);
    if (mode === "linked" && linkedId === "") {
      setError("Pick an expense to link, or switch to Standalone.");
      return;
    }
    if (person.trim() === "") {
      setError("Who is this IOU with?");
      return;
    }
    let minor: MinorUnits | null;
    try {
      minor = parseDollarsToMinor(amountText, baseCurrency);
    } catch {
      setError("Unknown currency — check your settings.");
      return;
    }
    if (minor === null || minor <= 0) {
      setError("Enter an amount like 25.00");
      return;
    }
    setSaving(true);
    try {
      const now = new Date().toISOString();
      const repos = createRepositories(getActiveDb());
      const split: Split = {
        id: crypto.randomUUID(),
        linkedTransactionId: mode === "linked" ? linkedId : "",
        person: person.trim(),
        amount: minor,
        currency: baseCurrency,
        direction,
        settled: false,
        countOnIt: direction === "TheyOweMe" ? countOnIt : false,
        createdAt: now,
      };
      if (expectedBy !== "") split.expectedBy = expectedBy as DateOnly;
      await repos.splits.put(split);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
      setSaving(false);
    }
  };

  return (
    <SheetShell title="New IOU" onClose={onClose}>
      <div className="mt-4 flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-2 rounded-2xl bg-stone-100 dark:bg-stone-800 p-1">
          {(["standalone", "linked"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-xl py-2 text-sm font-medium transition-colors ${
                mode === m ? "bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-sm" : "text-stone-500 dark:text-stone-400"
              }`}
            >
              {m === "linked" ? "Link an expense" : "Standalone"}
            </button>
          ))}
        </div>

        {mode === "linked" && (
          <div>
            <label htmlFor="iou-linked" className={labelCls}>
              Expense
            </label>
            <select
              id="iou-linked"
              value={linkedId}
              onChange={(e) => chooseLinked(e.target.value)}
              className={fieldCls}
            >
              <option value="">Pick an expense…</option>
              {transactions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.payee || "Expense"} · {formatMoney(t.amount, t.currency)} ·{" "}
                  {t.date}
                </option>
              ))}
            </select>
            {linkedTx && (
              <p className="mt-1.5 text-xs text-stone-500 dark:text-stone-400">
                Amount prefilled from this expense. You can change it.
              </p>
            )}
          </div>
        )}

        <div>
          <label htmlFor="iou-person" className={labelCls}>
            Person
          </label>
          <input
            id="iou-person"
            type="text"
            placeholder="Who is this with?"
            value={person}
            onChange={(e) => setPerson(e.target.value)}
            className={fieldCls}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="iou-amount" className={labelCls}>
              Amount ({baseCurrency})
            </label>
            <input
              id="iou-amount"
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              className={`${fieldCls} font-display text-xl`}
            />
          </div>
          <div>
            <label htmlFor="iou-direction" className={labelCls}>
              Direction
            </label>
            <select
              id="iou-direction"
              value={direction}
              onChange={(e) => setDirection(e.target.value as IouDirection)}
              className={fieldCls}
            >
              <option value="TheyOweMe">They owe me</option>
              <option value="IOweThem">I owe them</option>
            </select>
          </div>
        </div>

        <div>
          <label htmlFor="iou-expected" className={labelCls}>
            Expected by (optional)
          </label>
          <input
            id="iou-expected"
            type="date"
            value={expectedBy}
            onChange={(e) => setExpectedBy(e.target.value)}
            className={fieldCls}
          />
        </div>

        {direction === "TheyOweMe" && (
          <div className="flex items-center justify-between rounded-2xl bg-stone-50 dark:bg-stone-800 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-stone-900 dark:text-stone-100">Count on it</p>
              <p className="text-xs text-stone-500 dark:text-stone-400">
                Adds to safe-to-spend once an expected date is set.
              </p>
            </div>
            <Toggle
              checked={countOnIt}
              onChange={setCountOnIt}
              label="Count on it"
            />
          </div>
        )}

        {error && <p className="text-sm font-medium text-red-700 dark:text-red-300">{error}</p>}

        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-full bg-stone-900 dark:bg-stone-100 py-3 text-sm font-medium text-white dark:text-stone-900 transition-colors hover:bg-stone-700 dark:hover:bg-stone-200 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save IOU"}
        </button>
      </div>
    </SheetShell>
  );
}

export function SettleIouSheet({
  split,
  accounts,
  linkedExpense,
  linkedExpenses = [],
  onClose,
  onSettled,
}: {
  split: Split;
  accounts: Account[];
  linkedExpense: Transaction | undefined;
  /** Receipt list for reimbursement IOUs (expenses with splitId set). */
  linkedExpenses?: Transaction[];
  onClose: () => void;
  onSettled: () => Promise<void>;
}) {
  const owedToMalike = split.direction === "TheyOweMe";
  const reimbursement = isReimbursementSplit(split);
  const hasLinked = split.linkedTransactionId !== "";
  // Refund only when the linked expense still exists; otherwise a linked
  // IOU whose expense is gone settles as a plain money-in. Reimbursement
  // IOUs get their own receipt-checklist mode below.
  const mode: "refund" | "inflow" | "outflow" = owedToMalike
    ? hasLinked && linkedExpense
      ? "refund"
      : "inflow"
    : "outflow";

  const defaultAccountId = useMemo(() => {
    if (reimbursement) {
      // The reimbursement lands in his bank, not on the card the trip
      // was spent on — default to checking.
      return (
        accounts.find((a) => a.type === "Checking")?.id ??
        accounts.find((a) => a.type === "Cash")?.id ??
        accounts[0]?.id ??
        ""
      );
    }
    if (
      linkedExpense &&
      accounts.some((a) => a.id === linkedExpense.accountId)
    ) {
      return linkedExpense.accountId;
    }
    return accounts[0]?.id ?? "";
  }, [reimbursement, linkedExpense, accounts]);

  const [accountId, setAccountId] = useState(defaultAccountId);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Receipt checklist for reimbursement mode: null means "all checked".
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string> | null>(null);

  const account = accounts.find((a) => a.id === accountId);

  const isCovered = (id: string): boolean =>
    checkedIds === null || checkedIds.has(id);
  const toggleCovered = (id: string) => {
    setCheckedIds((prev) => {
      const base = prev ?? new Set(linkedExpenses.map((t) => t.id));
      const next = new Set(base);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const coveredExpenses = reimbursement
    ? linkedExpenses.filter((t) => isCovered(t.id))
    : [];
  const coveredTotal = sumMinor(coveredExpenses.map((t) => t.amount));

  const explainer =
    mode === "refund"
      ? "This records a refund against the linked expense — the money lands back in your ledger and offsets that spending. It never counts as income."
      : mode === "inflow"
        ? "This records the money coming in. IOU repayments never count as income."
        : "This records the payment going out as an expense.";
  const primaryLabel =
    mode === "refund"
      ? "Record refund & settle"
      : mode === "inflow"
        ? "Record money in & settle"
        : "Record payment & settle";

  const save = async (record: boolean) => {
    setError(null);
    const target = account;
    if (record) {
      if (!target) {
        setError("Pick an account.");
        return;
      }
      if (target.currency !== split.currency) {
        setError(
          `Pick a ${split.currency} account — ${target.name} is in ${target.currency}.`,
        );
        return;
      }
    }
    setSaving(true);
    try {
      const now = new Date().toISOString();
      const repos = createRepositories(getActiveDb());
      if (record && target) {
        const tx = buildSettlementTransaction({
          split,
          accountId: target.id,
          date: todayLocal(),
          nowIso: now,
          linkedExpense,
        });
        await repos.transactions.put(tx);
      }
      await repos.splits.put(settleIou(split, now));
      await onSettled();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
      setSaving(false);
    }
  };

  /**
   * Reimbursement settlement: one Refund per checked receipt on the
   * receiving account. Unchecked receipts are detached and stay as his
   * own spending.
   */
  const saveReimbursement = async () => {
    setError(null);
    const target = account;
    if (!target) {
      setError("Pick an account.");
      return;
    }
    if (target.currency !== split.currency) {
      setError(
        `Pick a ${split.currency} account — ${target.name} is in ${target.currency}.`,
      );
      return;
    }
    if (coveredExpenses.length === 0) {
      setError("Check at least one receipt — or settle without recording.");
      return;
    }
    setSaving(true);
    try {
      const now = new Date().toISOString();
      const repos = createRepositories(getActiveDb());
      await settleReimbursement(repos, {
        splitId: split.id,
        coveredExpenseIds: coveredExpenses.map((t) => t.id),
        receivingAccountId: target.id,
        date: todayLocal(),
        nowIso: now,
      });
      await onSettled();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
      setSaving(false);
    }
  };

  if (reimbursement) {
    return (
      <SheetShell title="Settle reimbursement" onClose={onClose}>
        <div className="mt-4 flex flex-col gap-4">
          <div className="flex items-center justify-between rounded-2xl bg-stone-50 dark:bg-stone-800 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-stone-900 dark:text-stone-100">
                {split.person}
              </p>
              <p className="text-xs text-stone-500 dark:text-stone-400">
                {linkedExpenses.length}{" "}
                {linkedExpenses.length === 1 ? "receipt" : "receipts"} ·{" "}
                {formatMoney(split.amount, split.currency)} claimed
              </p>
            </div>
            <DirectionBadge direction={split.direction} />
          </div>

          <p className="text-sm leading-relaxed text-stone-600 dark:text-stone-400">
            Check the receipts this reimbursement covers. Each checked one
            becomes a refund, so the trip spending nets to zero — never
            income. Unchecked receipts stay as your own spending.
          </p>

          {linkedExpenses.length === 0 ? (
            <p className="text-sm text-stone-500 dark:text-stone-400">
              No receipts attached yet. Add trip spending with the
              Reimbursable toggle in Quick-Log.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {linkedExpenses.map((t) => {
                const checked = isCovered(t.id);
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      onClick={() => toggleCovered(t.id)}
                      className={`flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left transition-colors ${
                        checked
                          ? "bg-stone-100 dark:bg-stone-800"
                          : "bg-white dark:bg-stone-900 opacity-60"
                      } ring-1 ring-inset ring-stone-200 dark:ring-stone-700`}
                    >
                      <span
                        aria-hidden="true"
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-xs font-bold text-white dark:text-stone-900 transition-colors ${
                          checked
                            ? "bg-stone-900 dark:bg-stone-100"
                            : "bg-stone-300 dark:bg-stone-600"
                        }`}
                      >
                        {checked ? "✓" : ""}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-stone-900 dark:text-stone-100">
                          {t.payee || "Expense"}
                        </span>
                        <span className="block text-xs text-stone-500 dark:text-stone-400">
                          {t.date}
                        </span>
                      </span>
                      <span className="shrink-0 font-display text-sm text-stone-900 dark:text-stone-100">
                        {formatMoney(t.amount, t.currency)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div>
            <label htmlFor="iou-reimburse-account" className={labelCls}>
              Reimbursement landed in
            </label>
            <select
              id="iou-reimburse-account"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className={fieldCls}
            >
              {accounts.length === 0 && (
                <option value="">No accounts yet</option>
              )}
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.currency}
                </option>
              ))}
            </select>
          </div>

          {error && <p className="text-sm font-medium text-red-700 dark:text-red-300">{error}</p>}

          <button
            type="button"
            onClick={() => void saveReimbursement()}
            disabled={saving || coveredExpenses.length === 0}
            className="rounded-full bg-stone-900 dark:bg-stone-100 py-3 text-sm font-medium text-white dark:text-stone-900 transition-colors hover:bg-stone-700 dark:hover:bg-stone-200 disabled:opacity-60"
          >
            {saving
              ? "Saving…"
              : `Record ${coveredExpenses.length} ${coveredExpenses.length === 1 ? "refund" : "refunds"} (${formatMoney(coveredTotal, split.currency)}) & settle`}
          </button>

          <div className="rounded-2xl bg-stone-50 dark:bg-stone-800 px-4 py-3">
            <button
              type="button"
              onClick={() => void save(false)}
              disabled={saving}
              className="text-sm font-medium text-stone-700 dark:text-stone-300 underline decoration-stone-300 underline-offset-2 disabled:opacity-60"
            >
              {saving ? "Saving…" : "Settle without recording"}
            </button>
            <p className="mt-1 text-xs leading-relaxed text-stone-500 dark:text-stone-400">
              Marks the IOU settled without touching the ledger. Use this when
              the money is already logged somewhere else.
            </p>
          </div>
        </div>
      </SheetShell>
    );
  }

  return (
    <SheetShell title="Settle IOU" onClose={onClose}>
      <div className="mt-4 flex flex-col gap-4">
        <div className="flex items-center justify-between rounded-2xl bg-stone-50 dark:bg-stone-800 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-stone-900 dark:text-stone-100">
              {split.person}
            </p>
            <p className="text-xs text-stone-500 dark:text-stone-400">
              {formatExpectedBy(split.expectedBy)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <p className="font-display text-lg text-stone-900 dark:text-stone-100">
              {formatMoney(split.amount, split.currency)}
            </p>
            <DirectionBadge direction={split.direction} />
          </div>
        </div>

        <p className="text-sm leading-relaxed text-stone-600 dark:text-stone-400">{explainer}</p>

        {mode === "refund" && linkedExpense && (
          <div className="rounded-2xl border border-stone-200 dark:border-stone-700 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400">
              Refunding
            </p>
            <p className="mt-1 text-sm text-stone-900 dark:text-stone-100">
              {linkedExpense.payee || "Expense"} ·{" "}
              {formatMoney(linkedExpense.amount, linkedExpense.currency)} ·{" "}
              {linkedExpense.date}
            </p>
          </div>
        )}
        {hasLinked && !linkedExpense && (
          <p className="text-xs leading-relaxed text-stone-500 dark:text-stone-400">
            The original expense is no longer in the ledger, so this records
            as a plain money-in rather than a refund.
          </p>
        )}

        <div>
          <label htmlFor="iou-settle-account" className={labelCls}>
            {owedToMalike ? "Receiving account" : "Paying account"}
          </label>
          <select
            id="iou-settle-account"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className={fieldCls}
          >
            {accounts.length === 0 && (
              <option value="">No accounts yet</option>
            )}
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.currency}
              </option>
            ))}
          </select>
        </div>

        {error && <p className="text-sm font-medium text-red-700 dark:text-red-300">{error}</p>}

        <button
          type="button"
          onClick={() => void save(true)}
          disabled={saving}
          className="rounded-full bg-stone-900 dark:bg-stone-100 py-3 text-sm font-medium text-white dark:text-stone-900 transition-colors hover:bg-stone-700 dark:hover:bg-stone-200 disabled:opacity-60"
        >
          {saving ? "Saving…" : primaryLabel}
        </button>

        <div className="rounded-2xl bg-stone-50 dark:bg-stone-800 px-4 py-3">
          <button
            type="button"
            onClick={() => void save(false)}
            disabled={saving}
            className="text-sm font-medium text-stone-700 dark:text-stone-300 underline decoration-stone-300 underline-offset-2 disabled:opacity-60"
          >
            {saving ? "Saving…" : "Settle without recording"}
          </button>
          <p className="mt-1 text-xs leading-relaxed text-stone-500 dark:text-stone-400">
            Marks the IOU settled without touching the ledger. Use this when
            the money is already logged somewhere else.
          </p>
        </div>
      </div>
    </SheetShell>
  );
}

export function Ious({ onChanged }: { onChanged: () => void }) {
  const [splits, setSplits] = useState<Split[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [allTransactions, setAllTransactions] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [baseCurrency, setBaseCurrency] = useState("USD");
  const [windowEnd, setWindowEnd] = useState<DateOnly>(todayLocal());
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [settleSplit, setSettleSplit] = useState<Split | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const repos = createRepositories(getActiveDb());
    const [open, txs, settings, rules, accts] = await Promise.all([
      repos.splits.unsettled(),
      repos.transactions.getAll(),
      repos.settings.get(),
      repos.recurringRules.getAll(),
      repos.accounts.active(),
    ]);
    setSplits(open.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    setAllTransactions(
      [...txs].sort((a, b) => b.date.localeCompare(a.date)),
    );
    setTransactions(
      txs
        .filter(
          (t) =>
            t.type === "Expense" &&
            (t.status === "Cleared" || t.status === "Pending"),
        )
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 30),
    );
    setAccounts(accts);
    if (settings?.baseCurrency) setBaseCurrency(settings.baseCurrency);
    // Match the dashboard's pay window so the "counted in safe-to-spend"
    // line agrees with the hero number.
    const today = todayLocal();
    const primaryRule = rules.find((r) => r.active && r.isPrimaryPayday) ?? null;
    const cycle = primaryRule ? resolvePayCycle(today, primaryRule) : null;
    setWindowEnd(cycle ? cycle.nextPayday : addDays(today, 30));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const afterWrite = useCallback(async () => {
    await load();
    onChanged();
  }, [load, onChanged]);

  const toggleCountOnIt = useCallback(
    async (split: Split, value: boolean) => {
      const repos = createRepositories(getActiveDb());
      await repos.splits.put({ ...split, countOnIt: value });
      await afterWrite();
    },
    [afterWrite],
  );

  const linkedExpenseOf = useCallback(
    (split: Split): Transaction | undefined =>
      split.linkedTransactionId === ""
        ? undefined
        : allTransactions.find((t) => t.id === split.linkedTransactionId),
    [allTransactions],
  );

  const countedTotal = useMemo(
    () => countedIouTotal(splits, windowEnd, baseCurrency),
    [splits, windowEnd, baseCurrency],
  );
  const countedAny = countedTotal !== 0;

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-stone-300 dark:border-stone-600 border-t-stone-800 dark:border-t-stone-200" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-3xl border border-stone-200/70 dark:border-stone-700 bg-white dark:bg-stone-900 px-2 py-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <div className="flex items-center justify-between px-4 pb-1">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400">
              IOUs
            </p>
            {countedAny && (
              <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
                {formatMoney(countedTotal, baseCurrency)} counted in
                safe-to-spend
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="rounded-full bg-stone-900 dark:bg-stone-100 px-3.5 py-1.5 text-xs font-medium text-white dark:text-stone-900 transition-colors hover:bg-stone-700 dark:hover:bg-stone-200"
          >
            New IOU
          </button>
        </div>

        {splits.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-stone-500 dark:text-stone-400">
            No open IOUs. When someone owes you, add it here and count on it
            when you are sure.
          </p>
        ) : (
          <div className="divide-y divide-stone-100 dark:divide-stone-800">
            {splits.map((s) => (
              <div key={s.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-stone-900 dark:text-stone-100">
                      {s.person}
                    </p>
                    <p className="text-xs text-stone-500 dark:text-stone-400">
                      {formatExpectedBy(s.expectedBy)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <p className="font-display text-lg text-stone-900 dark:text-stone-100">
                      {formatMoney(s.amount, s.currency)}
                    </p>
                    <DirectionBadge direction={s.direction} />
                  </div>
                </div>

                <div className="mt-2 flex items-center justify-between gap-2">
                  {s.direction === "TheyOweMe" ? (
                    <div className="flex items-center gap-2">
                      <Toggle
                        checked={s.countOnIt}
                        onChange={(v) => void toggleCountOnIt(s, v)}
                        label={`Count on it: ${s.person}`}
                      />
                      <span className="text-xs text-stone-500 dark:text-stone-400">Count on it</span>
                    </div>
                  ) : (
                    <span />
                  )}
                  <button
                    type="button"
                    onClick={() => setSettleSplit(s)}
                    className="rounded-full border border-stone-200 dark:border-stone-700 px-3 py-1.5 text-xs font-medium text-stone-700 dark:text-stone-300 transition-colors hover:bg-stone-50 dark:hover:bg-stone-800"
                  >
                    {isReimbursementSplit(s) ? "Review & settle" : "Settle"}
                  </button>
                </div>

                {isReimbursementSplit(s) && (
                  <ReceiptsExpander
                    split={s}
                    transactions={allTransactions}
                    expanded={expandedId === s.id}
                    onToggle={() =>
                      setExpandedId(expandedId === s.id ? null : s.id)
                    }
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {createOpen && (
        <CreateIouSheet
          transactions={transactions}
          baseCurrency={baseCurrency}
          onClose={() => setCreateOpen(false)}
          onSaved={async () => {
            setCreateOpen(false);
            await afterWrite();
          }}
        />
      )}

      {settleSplit && (
        <SettleIouSheet
          split={settleSplit}
          accounts={accounts}
          linkedExpense={linkedExpenseOf(settleSplit)}
          linkedExpenses={linkedReimbursementExpenses(
            allTransactions,
            settleSplit.id,
          )}
          onClose={() => setSettleSplit(null)}
          onSettled={async () => {
            setSettleSplit(null);
            await afterWrite();
          }}
        />
      )}
    </div>
  );
}

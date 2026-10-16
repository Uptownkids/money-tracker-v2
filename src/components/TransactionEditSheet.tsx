/**
 * TransactionEditSheet: the shared transaction edit sheet, extracted
 * from EverythingLog so Today's Moves can open the same bill editor
 * from the dashboard. It handles the generated-bill occurrence/future
 * scope chooser and locks debt-payment rows (Worker A) to Transfer
 * type with the rule's destination account.
 */
import { useEffect, useState } from "react";
import { createRepositories } from "../data/repositories/index.js";
import { getActiveDb } from "../data/db.js";
import {
  applyBillEdit,
  rekeyOverrideForMove,
} from "../domain/engine/ledger.js";
import type { BillEditChanges } from "../domain/engine/ledger.js";
import { parseDollarsToMinor } from "../app/quickLog.js";
import { decimalsOf } from "../domain/money/currency.js";
import { isDateOnly, todayLocal } from "../domain/dates/dateOnly.js";
import type { DateOnly } from "../domain/dates/dateOnly.js";
import type { MinorUnits } from "../domain/money/money.js";
import type { Account } from "../domain/entities/account.js";
import type { Category } from "../domain/entities/category.js";
import { expenseCategories } from "../domain/entities/category.js";
import type {
  Transaction,
  TransactionType,
} from "../domain/entities/transaction.js";
import type { RecurringRule } from "../domain/entities/recurringRule.js";
import type { Goal } from "../domain/entities/goal.js";

type QuickType = "Expense" | "Income" | "Transfer";
const QUICK_TYPES: QuickType[] = ["Expense", "Income", "Transfer"];

function minorToDollars(minor: MinorUnits, currency: string): string {
  const d = decimalsOf(currency);
  return (minor / 10 ** d).toFixed(d);
}

const fieldCls =
  "w-full rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-3.5 py-2.5 text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 focus:border-stone-400 dark:focus:border-stone-500 focus:outline-none";
const labelCls = "mb-1.5 block text-xs font-medium text-stone-500 dark:text-stone-400";

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

export function TransactionEditSheet({
  tx,
  accounts,
  categories,
  onClose,
  onSaved,
  onDelete,
  onSkip,
  occurrenceTaken,
}: {
  tx: Transaction;
  accounts: Account[];
  categories: Category[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  onDelete: (tx: Transaction) => Promise<void>;
  onSkip: (tx: Transaction) => Promise<void>;
  occurrenceTaken: (ruleId: string, occurrenceDate: DateOnly, excludeTxId: string) => boolean;
}) {
  const account = accounts.find((a) => a.id === tx.accountId);
  const accountCurrency = account?.currency ?? tx.currency;
  const initialMinor = tx.fx ? tx.fx.baseAmount : tx.amount;
  const isQuickType = (t: TransactionType): t is QuickType =>
    t === "Expense" || t === "Income" || t === "Transfer";

  const [type, setType] = useState<QuickType>(isQuickType(tx.type) ? tx.type : "Expense");
  const [typeTouched, setTypeTouched] = useState(false);
  const [amount, setAmount] = useState(minorToDollars(initialMinor, accountCurrency));
  const [accountId, setAccountId] = useState(tx.accountId);
  const [toAccountId, setToAccountId] = useState(tx.transferToAccountId ?? "");
  const [categoryId, setCategoryId] = useState(tx.categoryId ?? "");
  const [payee, setPayee] = useState(tx.payee);
  const [notes, setNotes] = useState(tx.notes);
  const [isBusiness, setIsBusiness] = useState(tx.tags.includes("business"));
  const [date, setDate] = useState<DateOnly>(tx.date);
  const [phase, setPhase] = useState<"form" | "scope">("form");
  const [rule, setRule] = useState<RecurringRule | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [goalId, setGoalId] = useState(tx.goalId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmSkip, setConfirmSkip] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const repos = createRepositories(getActiveDb());
      const [r, gs] = await Promise.all([
        tx.recurringRuleId && tx.occurrenceDate
          ? repos.recurringRules.getById(tx.recurringRuleId)
          : Promise.resolve(null),
        repos.goals.getAll(),
      ]);
      if (alive) {
        setRule(r ?? null);
        setGoals(gs);
      }
    })();
    return () => {
      alive = false;
    };
  }, [tx]);

  // Debt-payment rows (generated from a rule with payToAccountId) are
  // always Transfers to the debt account — the type and destination are
  // locked so a settle can never rewrite them into an expense.
  const isDebtPaymentRow =
    rule?.payToAccountId !== undefined && rule.payToAccountId !== "";
  const effectiveType: TransactionType = isDebtPaymentRow
    ? "Transfer"
    : typeTouched
      ? type
      : tx.type;

  const pickType = (t: QuickType) => {
    setType(t);
    setTypeTouched(true);
    if (t !== "Transfer") {
      const kind = t === "Expense" ? "expense" : "income";
      setCategoryId(categories.find((c) => c.kind === kind)?.id ?? "");
    }
  };

  const minor = parseDollarsToMinor(amount, accounts.find((a) => a.id === accountId)?.currency);
  const amountChanged = minor !== null && minor !== initialMinor;
  const dateChanged = date !== tx.date;
  const accountChanged = accountId !== tx.accountId;
  const categoryChanged = (categoryId || null) !== (tx.categoryId ?? null);
  const toAccountChanged = (toAccountId || undefined) !== (tx.transferToAccountId ?? undefined);
  const payeeChanged = payee.trim() !== tx.payee;
  const notesChanged = notes.trim() !== tx.notes;
  const typeChanged = typeTouched && type !== tx.type;
  const goalChanged =
    effectiveType === "Transfer" && !isDebtPaymentRow
      ? (goalId || undefined) !== (tx.goalId ?? undefined)
      : false;
  const ruleRelevantChanged = amountChanged || dateChanged || accountChanged || categoryChanged;
  // A generated Scheduled row can be skipped (never regenerated) instead
  // of deleted outright. Generated Cleared/Pending rows are history and
  // keep the plain delete path.
  const skippable =
    tx.status === "Scheduled" &&
    tx.recurringRuleId !== undefined &&
    tx.occurrenceDate !== undefined;

  const persist = async (scope: "occurrence" | "future" | null) => {
    setError(null);
    const acct = accounts.find((a) => a.id === accountId);
    if (!acct) {
      setError("Pick an account.");
      return;
    }
    if (minor === null) {
      setError("Enter an amount like 12.34");
      return;
    }
    if (effectiveType === "Transfer" && !toAccountId) {
      setError("Pick the destination account.");
      return;
    }
    if (!isDateOnly(date)) {
      setError("Pick a valid date.");
      return;
    }
    setSaving(true);
    try {
      const repos = createRepositories(getActiveDb());
      const nowIso = new Date().toISOString();
      if (scope !== null && rule && tx.occurrenceDate) {
        const changes: BillEditChanges = {};
        if (amountChanged) changes.amount = minor;
        if (dateChanged) changes.date = date;
        if (accountChanged) changes.accountId = accountId;
        if (categoryChanged && categoryId) changes.categoryId = categoryId;
        // "Future" + date moves the schedule: two rows must never share
        // the same (ruleId, occurrenceDate) key, or the merge would drop one.
        if (
          scope === "future" &&
          changes.date !== undefined &&
          occurrenceTaken(rule.id, changes.date, tx.id)
        ) {
          setSaving(false);
          setError(`There's already a ${rule.name} occurrence on that date.`);
          return;
        }
        const result = applyBillEdit(rule, tx.occurrenceDate, changes, nowIso, scope);
        if (scope === "occurrence") {
          if (result.override) await repos.recurringOverrides.put(result.override);
        } else {
          if (result.rule) await repos.recurringRules.put(result.rule);
          if (result.override) await repos.recurringOverrides.put(result.override);
          if (changes.date !== undefined) {
            // The occurrence moved: carry any prior single-occurrence edit
            // along to the new date instead of orphaning it.
            const overrides = await repos.recurringOverrides.byRule(rule.id);
            const rekeyed = rekeyOverrideForMove(overrides, rule.id, tx.occurrenceDate, changes.date);
            if (rekeyed) {
              await repos.recurringOverrides.remove(rekeyed.deleteId);
              await repos.recurringOverrides.put(rekeyed.override);
            }
          }
        }
      }
      // "Future" + date moves the schedule itself, so the row's identity
      // follows the new date: projection and row then share the
      // (ruleId, occurrenceDate) dedupe key and committed counts the bill
      // exactly once. "Occurrence" scope never moves the rule, so the row's
      // occurrenceDate stays put.
      const movedOccurrenceDate =
        scope === "future" && dateChanged ? date : tx.occurrenceDate;
      const updated: Transaction = {
        ...tx,
        occurrenceDate: movedOccurrenceDate,
        type: effectiveType,
        // FX freeze handling: if the amount is untouched and the account
        // is unchanged, keep the original amount/currency/fx triple
        // exactly as-is. If the amount changed, the new amount is
        // authoritative in the account's currency and the stale freeze
        // must go — otherwise the engine would keep using fx.baseAmount
        // and silently ignore the edit.
        amount: !amountChanged && !accountChanged && tx.fx ? tx.amount : minor,
        currency: !amountChanged && !accountChanged && tx.fx ? tx.currency : acct.currency,
        date,
        accountId,
        categoryId: effectiveType === "Transfer" ? null : categoryId || null,
        payee: payee.trim(),
        notes: notes.trim(),
        tags: isBusiness
          ? [...new Set([...tx.tags, "business"])]
          : tx.tags.filter((t) => t !== "business"),
        updatedAt: nowIso,
      };
      if (effectiveType === "Transfer") {
        // Debt-payment rows are locked to the rule's destination account.
        updated.transferToAccountId = isDebtPaymentRow
          ? rule!.payToAccountId
          : toAccountId || undefined;
      } else {
        delete updated.transferToAccountId;
      }
      // Linking a transfer to a goal is what makes it count toward the
      // goal's progress and this cycle's contribution. Debt-payment rows
      // are system-managed bill payments, so the picker is hidden for
      // them and any existing link is left untouched.
      if (effectiveType === "Transfer" && !isDebtPaymentRow) {
        updated.goalId = goalId || undefined;
      }
      if (amountChanged || accountChanged) delete updated.fx;
      await repos.transactions.put(updated);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
      setSaving(false);
    }
  };

  const save = () => {
    const needsScope =
      tx.recurringRuleId !== undefined &&
      tx.occurrenceDate !== undefined &&
      rule !== null &&
      ruleRelevantChanged;
    if (needsScope) {
      setPhase("scope");
    } else {
      void persist(null);
    }
  };

  const visibleCategories =
    effectiveType === "Income"
      ? categories.filter((c) => c.kind === "income")
      : expenseCategories(categories);

  const nothingChanged =
    !amountChanged && !dateChanged && !accountChanged && !categoryChanged &&
    !toAccountChanged && !payeeChanged && !notesChanged && !typeChanged &&
    !goalChanged && isBusiness === tx.tags.includes("business");

  return (
    <SheetShell title="Edit transaction" onClose={onClose}>
      <div className="mt-4 flex flex-col gap-4">
        {isDebtPaymentRow ? (
          <p className="rounded-xl bg-stone-100 dark:bg-stone-800 px-4 py-2.5 text-sm font-medium text-stone-600 dark:text-stone-400">
            Debt payment — always a transfer
          </p>
        ) : (
          <div className="flex rounded-full bg-stone-100 dark:bg-stone-800 p-1" role="group" aria-label="Entry type">
            {QUICK_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => pickType(t)}
                className={`flex-1 rounded-full py-2 text-sm font-medium transition-colors ${
                  effectiveType === t
                    ? "bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-sm"
                    : "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        )}

        <div>
          <label htmlFor="et-amount" className={labelCls}>
            Amount
          </label>
          <input
            id="et-amount"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={`${fieldCls} font-display text-2xl`}
          />
        </div>

        <div>
          <label htmlFor="et-account" className={labelCls}>
            Account
          </label>
          <select
            id="et-account"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className={fieldCls}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>

        {effectiveType === "Transfer" && (
          <div>
            <label htmlFor="et-to-account" className={labelCls}>
              To account
            </label>
            <select
              id="et-to-account"
              value={toAccountId}
              onChange={(e) => setToAccountId(e.target.value)}
              disabled={isDebtPaymentRow}
              className={`${fieldCls} disabled:opacity-60`}
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

        {effectiveType === "Transfer" && !isDebtPaymentRow && (
          <div>
            <label htmlFor="et-goal" className={labelCls}>
              Goal (optional)
            </label>
            <select
              id="et-goal"
              value={goalId}
              onChange={(e) => setGoalId(e.target.value)}
              className={fieldCls}
            >
              <option value="">No goal</option>
              {goals
                .filter((g) => !g.completed && g.currency === accountCurrency)
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
            </select>
            <p className="pt-1.5 text-xs text-stone-500 dark:text-stone-400">
              Link this transfer to count it toward the goal's progress.
            </p>
          </div>
        )}

        {effectiveType !== "Transfer" && (
          <div>
            <label htmlFor="et-category" className={labelCls}>
              Category
            </label>
            <select
              id="et-category"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className={fieldCls}
            >
              <option value="">No category</option>
              {visibleCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label htmlFor="et-payee" className={labelCls}>
            Payee
          </label>
          <input
            id="et-payee"
            type="text"
            placeholder="Who or what"
            value={payee}
            onChange={(e) => setPayee(e.target.value)}
            className={fieldCls}
          />
        </div>

        <div>
          <label htmlFor="et-notes" className={labelCls}>
            Notes
          </label>
          <input
            id="et-notes"
            type="text"
            placeholder="Optional"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className={fieldCls}
          />
        </div>

        <label className="flex items-center gap-2 text-sm text-stone-700 dark:text-stone-300">
          <input
            id="et-business"
            type="checkbox"
            checked={isBusiness}
            onChange={(e) => setIsBusiness(e.target.checked)}
          />
          Business expense
        </label>

        <div>
          <label htmlFor="et-date" className={labelCls}>
            Date
          </label>
          <input
            id="et-date"
            type="date"
            value={date}
            onChange={(e) =>
              setDate(isDateOnly(e.target.value) ? e.target.value : todayLocal())
            }
            className={fieldCls}
          />
        </div>

        {phase === "scope" ? (
          <div className="rounded-2xl bg-stone-100 dark:bg-stone-800 p-4">
            <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
              This transaction was generated from a repeating rule. Apply the
              change to:
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <button
                type="button"
                disabled={saving}
                onClick={() => void persist("occurrence")}
                className="rounded-full bg-stone-900 dark:bg-stone-100 py-2.5 text-sm font-medium text-white dark:text-stone-900 transition-colors hover:bg-stone-700 dark:hover:bg-stone-200 disabled:opacity-60"
              >
                This occurrence only
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void persist("future")}
                className="rounded-full bg-white dark:bg-stone-900 py-2.5 text-sm font-medium text-stone-900 dark:text-stone-100 ring-1 ring-inset ring-stone-300 dark:ring-stone-600 transition-colors hover:bg-stone-50 dark:hover:bg-stone-800 disabled:opacity-60"
              >
                This and all future
              </button>
              <button
                type="button"
                onClick={() => setPhase("form")}
                className="py-1 text-sm font-medium text-stone-500 dark:text-stone-400"
              >
                Back
              </button>
            </div>
          </div>
        ) : confirmSkip && skippable ? (
          <div className="rounded-2xl bg-stone-100 dark:bg-stone-800 p-4">
            <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
              Skip this occurrence?
            </p>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
              This scheduled payment will be removed and won't be generated
              again. The repeating rule stays active.
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => void onSkip(tx)}
                className="rounded-full bg-stone-900 dark:bg-stone-100 py-2.5 text-sm font-medium text-white dark:text-stone-900 transition-colors hover:bg-stone-700 dark:hover:bg-stone-200"
              >
                Skip occurrence
              </button>
              <button
                type="button"
                onClick={() => setConfirmSkip(false)}
                className="py-1 text-sm font-medium text-stone-500 dark:text-stone-400"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            {error && <p className="text-sm font-medium text-red-700 dark:text-red-300">{error}</p>}
            <button
              type="button"
              onClick={save}
              disabled={saving || nothingChanged}
              className="rounded-full bg-stone-900 dark:bg-stone-100 py-3 text-sm font-medium text-white dark:text-stone-900 transition-colors hover:bg-stone-700 dark:hover:bg-stone-200 disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                if (skippable) setConfirmSkip(true);
                else void onDelete(tx);
              }}
              className="py-1 text-sm font-medium text-red-700 dark:text-red-300"
            >
              Delete transaction
            </button>
          </>
        )}
      </div>
    </SheetShell>
  );
}

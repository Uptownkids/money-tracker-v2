/**
 * Everything Log: the full transaction feed, newest first, with filters,
 * an edit sheet (including the generated-bill occurrence/future scope
 * chooser), and delete-with-undo.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRepositories } from "../data/repositories/index.js";
import { getActiveDb } from "../data/db.js";
import {
  addSkippedDate,
  computeRunningBalances,
  removeSkippedDate,
} from "../domain/engine/ledger.js";
import { isBeforeTrackingStarted } from "../domain/engine/balances.js";
import { formatMoney } from "../app/format.js";
import type { DateOnly } from "../domain/dates/dateOnly.js";
import type { MinorUnits } from "../domain/money/money.js";
import type { Account } from "../domain/entities/account.js";
import type { Category } from "../domain/entities/category.js";
import type {
  Transaction,
  TransactionStatus,
  TransactionType,
} from "../domain/entities/transaction.js";
import { TransactionEditSheet } from "./TransactionEditSheet.js";

const ALL_TYPES: TransactionType[] = ["Income", "Expense", "Transfer", "Refund"];
const STATUSES: TransactionStatus[] = ["Scheduled", "Pending", "Cleared"];

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function shortDate(d: DateOnly): string {
  const m = MONTHS[Number(d.slice(5, 7)) - 1] ?? "";
  return `${m} ${Number(d.slice(8, 10))}`;
}

const filterCls =
  "rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-3 py-2 text-sm text-stone-900 dark:text-stone-100 focus:border-stone-400 dark:focus:border-stone-500 focus:outline-none";

const PILL: Record<TransactionStatus, string> = {
  Scheduled:
    "rounded-full border border-dashed border-stone-300 dark:border-stone-600 bg-stone-50 dark:bg-stone-800 px-2 py-0.5 text-[10px] font-medium text-stone-500 dark:text-stone-400",
  Pending:
    "rounded-full bg-amber-100 dark:bg-amber-900 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-200",
  Cleared:
    "rounded-full bg-emerald-100 dark:bg-emerald-900 px-2 py-0.5 text-[10px] font-medium text-emerald-800 dark:text-emerald-200",
};

function TxRow({
  tx,
  accounts,
  categories,
  balance,
  onOpen,
}: {
  tx: Transaction;
  accounts: Account[];
  categories: Category[];
  balance: MinorUnits | undefined;
  onOpen: () => void;
}) {
  const account = accounts.find((a) => a.id === tx.accountId);
  const category = categories.find((c) => c.id === tx.categoryId);
  const currency = account?.currency ?? tx.currency;
  const displayAmount = tx.fx ? tx.fx.baseAmount : tx.amount;
  const scheduled = tx.status === "Scheduled";
  // Dated before this account started being tracked: history only, the
  // starting balance already reflects it, so no running balance applies.
  const beforeTracking = isBeforeTrackingStarted(account, tx.date);

  const sign =
    tx.type === "Income" ? "+" : tx.type === "Transfer" ? "" : "−";
  const amountCls =
    tx.type === "Income"
      ? "text-emerald-700 dark:text-emerald-300"
      : tx.type === "Transfer"
        ? "text-stone-500 dark:text-stone-400"
        : "text-stone-900 dark:text-stone-100";

  const accountName = (id: string | undefined) =>
    accounts.find((a) => a.id === id)?.name ?? "Unknown account";

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex w-full items-center gap-3 rounded-2xl border bg-white dark:bg-stone-900 px-4 py-3 text-left shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:bg-stone-50 dark:hover:bg-stone-800 ${
        scheduled ? "border-dashed border-stone-300 dark:border-stone-600 opacity-70" : "border-stone-200/70 dark:border-stone-700"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-xs font-medium text-stone-400">{shortDate(tx.date)}</p>
          <span className={PILL[tx.status]}>{tx.status}</span>
        </div>
        <p className="truncate pt-0.5 text-sm font-medium text-stone-900 dark:text-stone-100">
          {tx.payee || "No payee"}
        </p>
        <p className="truncate text-xs text-stone-500 dark:text-stone-400">
          {tx.type === "Transfer"
            ? `${accountName(tx.accountId)} → ${accountName(tx.transferToAccountId)}`
            : (category?.name ?? "No category")}
        </p>
        {beforeTracking ? (
          <p className="text-xs italic text-stone-400">Before tracking started</p>
        ) : (
          balance !== undefined && (
            <p className="text-xs text-stone-400">
              Balance {formatMoney(balance, currency)}
            </p>
          )
        )}
      </div>
      <p className={`shrink-0 font-display text-lg ${amountCls}`}>
        {sign}
        {formatMoney(displayAmount, currency)}
      </p>
    </button>
  );
}


export function EverythingLog({ onChanged }: { onChanged: () => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [running, setRunning] = useState<Record<string, MinorUnits>>({});
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [deleted, setDeleted] = useState<{
    tx: Transaction;
    skip?: { ruleId: string; occurrenceDate: DateOnly };
  } | null>(null);

  const [fAccount, setFAccount] = useState("");
  const [fFrom, setFFrom] = useState("");
  const [fTo, setFTo] = useState("");
  const [fType, setFType] = useState("");
  const [fCategory, setFCategory] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [fSearch, setFSearch] = useState("");

  const undoTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    },
    [],
  );

  const load = useCallback(async () => {
    const repos = createRepositories(getActiveDb());
    const [accts, cats, txs] = await Promise.all([
      repos.accounts.active(),
      repos.categories.getAll(),
      repos.transactions.getAll(),
    ]);
    setAccounts(accts);
    setCategories(cats.filter((c) => !c.archived));
    setTransactions(txs);
    setRunning(computeRunningBalances(accts, txs));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const afterWrite = useCallback(async () => {
    await load();
    onChanged();
  }, [load, onChanged]);

  const handleDelete = useCallback(
    async (tx: Transaction) => {
      const repos = createRepositories(getActiveDb());
      await repos.transactions.remove(tx.id);
      setEditing(null);
      setDeleted({ tx });
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
      undoTimer.current = window.setTimeout(() => setDeleted(null), 6000);
      await afterWrite();
    },
    [afterWrite],
  );

  /** Skip a generated Scheduled occurrence: the rule keeps the date in
   * skippedDates (so it never regenerates) and the row leaves committed.
   * Undo restores both the row and the rule's skippedDates. */
  const handleSkipOccurrence = useCallback(
    async (tx: Transaction) => {
      const repos = createRepositories(getActiveDb());
      let skip: { ruleId: string; occurrenceDate: DateOnly } | undefined;
      if (tx.recurringRuleId && tx.occurrenceDate) {
        const rule = await repos.recurringRules.getById(tx.recurringRuleId);
        if (rule) {
          await repos.recurringRules.put(addSkippedDate(rule, tx.occurrenceDate));
          skip = { ruleId: rule.id, occurrenceDate: tx.occurrenceDate };
        }
      }
      await repos.transactions.remove(tx.id);
      setEditing(null);
      setDeleted({ tx, skip });
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
      undoTimer.current = window.setTimeout(() => setDeleted(null), 6000);
      await afterWrite();
    },
    [afterWrite],
  );

  const undoDelete = useCallback(async () => {
    if (!deleted) return;
    const repos = createRepositories(getActiveDb());
    if (deleted.skip) {
      const rule = await repos.recurringRules.getById(deleted.skip.ruleId);
      if (rule) {
        await repos.recurringRules.put(removeSkippedDate(rule, deleted.skip.occurrenceDate));
      }
    }
    await repos.transactions.put(deleted.tx);
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    setDeleted(null);
    await afterWrite();
  }, [deleted, afterWrite]);

  /** Collision guard for "future" + date moves: no two rows may share a
   * (ruleId, occurrenceDate) identity, or the committed merge drops one. */
  const occurrenceTaken = useCallback(
    (ruleId: string, occurrenceDate: DateOnly, excludeTxId: string) =>
      transactions.some(
        (t) =>
          t.id !== excludeTxId &&
          t.recurringRuleId === ruleId &&
          t.occurrenceDate === occurrenceDate,
      ),
    [transactions],
  );

  const filtered = useMemo(() => {
    const q = fSearch.trim().toLowerCase();
    return transactions
      .filter((t) => fAccount === "" || t.accountId === fAccount)
      .filter((t) => fFrom === "" || t.date >= fFrom)
      .filter((t) => fTo === "" || t.date <= fTo)
      .filter((t) => fType === "" || t.type === fType)
      .filter((t) => fCategory === "" || t.categoryId === fCategory)
      .filter((t) => fStatus === "" || t.status === fStatus)
      .filter(
        (t) =>
          q === "" ||
          t.payee.toLowerCase().includes(q) ||
          t.notes.toLowerCase().includes(q) ||
          t.tags.some((tag) => tag.toLowerCase().includes(q)),
      )
      .sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
        return 0;
      });
  }, [transactions, fAccount, fFrom, fTo, fType, fCategory, fStatus, fSearch]);

  const hasFilters =
    fAccount !== "" || fFrom !== "" || fTo !== "" || fType !== "" ||
    fCategory !== "" || fStatus !== "" || fSearch.trim() !== "";

  const clearFilters = () => {
    setFAccount("");
    setFFrom("");
    setFTo("");
    setFType("");
    setFCategory("");
    setFStatus("");
    setFSearch("");
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-stone-300 dark:border-stone-600 border-t-stone-800 dark:border-t-stone-200" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-3xl border border-stone-200/70 dark:border-stone-700 bg-white dark:bg-stone-900 p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <div className="flex flex-wrap gap-2">
          <input
            type="text"
            value={fSearch}
            onChange={(e) => setFSearch(e.target.value)}
            placeholder="Search payee, notes, tags"
            aria-label="Search transactions"
            className={`${filterCls} min-w-[140px] flex-1`}
          />
          <select
            value={fAccount}
            onChange={(e) => setFAccount(e.target.value)}
            aria-label="Filter by account"
            className={filterCls}
          >
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select
            value={fType}
            onChange={(e) => setFType(e.target.value)}
            aria-label="Filter by type"
            className={filterCls}
          >
            <option value="">All types</option>
            {ALL_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select
            value={fCategory}
            onChange={(e) => setFCategory(e.target.value)}
            aria-label="Filter by category"
            className={filterCls}
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            value={fStatus}
            onChange={(e) => setFStatus(e.target.value)}
            aria-label="Filter by status"
            className={filterCls}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={fFrom}
            onChange={(e) => setFFrom(e.target.value)}
            aria-label="From date"
            className={filterCls}
          />
          <input
            type="date"
            value={fTo}
            onChange={(e) => setFTo(e.target.value)}
            aria-label="To date"
            className={filterCls}
          />
          {hasFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="rounded-xl px-3 py-2 text-sm font-medium text-stone-500 dark:text-stone-400 transition-colors hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              Clear
            </button>
          )}
        </div>
      </section>

      {filtered.length === 0 ? (
        <p className="py-10 text-center text-sm text-stone-500 dark:text-stone-400">
          {hasFilters ? "No transactions match these filters." : "No transactions yet."}
        </p>
      ) : (
        filtered.map((tx) => (
          <TxRow
            key={tx.id}
            tx={tx}
            accounts={accounts}
            categories={categories}
            balance={running[tx.id]}
            onOpen={() => setEditing(tx)}
          />
        ))
      )}

      {editing && (
        <TransactionEditSheet
          key={editing.id}
          tx={editing}
          accounts={accounts}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await afterWrite();
          }}
          onDelete={handleDelete}
          onSkip={handleSkipOccurrence}
          occurrenceTaken={occurrenceTaken}
        />
      )}

      {deleted && (
        <div className="fixed bottom-28 left-1/2 z-50 -translate-x-1/2">
          <div className="flex items-center gap-2 rounded-full bg-stone-900 dark:bg-stone-100 py-2.5 pl-5 pr-2.5 text-sm text-white dark:text-stone-900 shadow-lg">
            <span>{deleted.skip ? "Skipped —" : "Deleted —"}</span>
            <button
              type="button"
              onClick={() => void undoDelete()}
              className="rounded-full bg-stone-700 dark:bg-stone-300 px-3 py-1 text-xs font-medium transition-colors hover:bg-stone-600 dark:hover:bg-stone-400"
            >
              Undo
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

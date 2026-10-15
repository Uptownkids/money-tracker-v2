/**
 * Dashboard-hosted sheets for Today's Moves taps: the shared bill edit
 * sheet (same component as the Log tab's, with delete/skip + undo) and
 * the shared IOU settle sheet. Both load their own data via
 * getActiveDb() so demo mode stays isolated.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createRepositories } from "../data/repositories/index.js";
import { getActiveDb } from "../data/db.js";
import {
  addSkippedDate,
  removeSkippedDate,
} from "../domain/engine/ledger.js";
import { TransactionEditSheet } from "./TransactionEditSheet.js";
import { SettleIouSheet } from "./Ious.js";
import type { DateOnly } from "../domain/dates/dateOnly.js";
import type { Account } from "../domain/entities/account.js";
import type { Category } from "../domain/entities/category.js";
import type { Transaction } from "../domain/entities/transaction.js";
import type { Split } from "../domain/entities/split.js";

function UndoToast({
  label,
  onUndo,
}: {
  label: string;
  onUndo: () => void;
}) {
  return (
    <div className="fixed bottom-28 left-1/2 z-50 -translate-x-1/2">
      <div className="flex items-center gap-2 rounded-full bg-stone-900 dark:bg-stone-100 py-2.5 pl-5 pr-2.5 text-sm text-white dark:text-stone-900 shadow-lg">
        <span>{label}</span>
        <button
          type="button"
          onClick={onUndo}
          className="rounded-full bg-stone-700 dark:bg-stone-300 px-3 py-1 text-xs font-medium transition-colors hover:bg-stone-600 dark:hover:bg-stone-400"
        >
          Undo
        </button>
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-stone-300 dark:border-stone-600 border-t-stone-800 dark:border-t-stone-200" />
    </div>
  );
}

/**
 * The bill edit sheet for a Today's Moves bill tap, hosted on the
 * dashboard. Same TransactionEditSheet as the Log tab, with working
 * save / delete-with-undo / skip-occurrence.
 */
export function BillMoveSheet({
  tx,
  onClose,
  onChanged,
}: {
  tx: Transaction;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleted, setDeleted] = useState<{
    tx: Transaction;
    skip?: { ruleId: string; occurrenceDate: DateOnly };
  } | null>(null);

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
    async (t: Transaction) => {
      const repos = createRepositories(getActiveDb());
      await repos.transactions.remove(t.id);
      onClose();
      setDeleted({ tx: t });
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
      undoTimer.current = window.setTimeout(() => setDeleted(null), 6000);
      await afterWrite();
    },
    [afterWrite, onClose],
  );

  const handleSkipOccurrence = useCallback(
    async (t: Transaction) => {
      const repos = createRepositories(getActiveDb());
      let skip: { ruleId: string; occurrenceDate: DateOnly } | undefined;
      if (t.recurringRuleId && t.occurrenceDate) {
        const rule = await repos.recurringRules.getById(t.recurringRuleId);
        if (rule) {
          await repos.recurringRules.put(addSkippedDate(rule, t.occurrenceDate));
          skip = { ruleId: rule.id, occurrenceDate: t.occurrenceDate };
        }
      }
      await repos.transactions.remove(t.id);
      onClose();
      setDeleted({ tx: t, skip });
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
      undoTimer.current = window.setTimeout(() => setDeleted(null), 6000);
      await afterWrite();
    },
    [afterWrite, onClose],
  );

  const undoDelete = useCallback(async () => {
    if (!deleted) return;
    const repos = createRepositories(getActiveDb());
    if (deleted.skip) {
      const rule = await repos.recurringRules.getById(deleted.skip.ruleId);
      if (rule) {
        await repos.recurringRules.put(
          removeSkippedDate(rule, deleted.skip.occurrenceDate),
        );
      }
    }
    await repos.transactions.put(deleted.tx);
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    setDeleted(null);
    await afterWrite();
  }, [deleted, afterWrite]);

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

  if (loading) return <Loading />;

  return (
    <>
      <TransactionEditSheet
        key={tx.id}
        tx={tx}
        accounts={accounts}
        categories={categories}
        onClose={onClose}
        onSaved={async () => {
          onClose();
          await afterWrite();
        }}
        onDelete={handleDelete}
        onSkip={handleSkipOccurrence}
        occurrenceTaken={occurrenceTaken}
      />
      {deleted && (
        <UndoToast
          label={deleted.skip ? "Skipped —" : "Deleted —"}
          onUndo={() => void undoDelete()}
        />
      )}
    </>
  );
}

/**
 * The IOU settle sheet for a Today's Moves old-IOU tap, hosted on the
 * dashboard. Reuses the IOUs tab's SettleIouSheet.
 */
export function IouMoveSheet({
  splitId,
  onClose,
  onChanged,
}: {
  splitId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [split, setSplit] = useState<Split | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const repos = createRepositories(getActiveDb());
      const [s, accts, txs] = await Promise.all([
        repos.splits.getById(splitId),
        repos.accounts.active(),
        repos.transactions.getAll(),
      ]);
      if (!alive) return;
      setSplit(s && !s.settled ? s : null);
      setAccounts(accts);
      setTransactions(txs);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [splitId]);

  // The split is gone (settled or deleted elsewhere): nothing to show.
  useEffect(() => {
    if (!loading && split === null) onClose();
  }, [loading, split, onClose]);

  if (loading || split === null) return loading ? <Loading /> : null;

  const linkedExpense =
    split.linkedTransactionId === ""
      ? undefined
      : transactions.find((t) => t.id === split.linkedTransactionId);

  return (
    <SettleIouSheet
      split={split}
      accounts={accounts}
      linkedExpense={linkedExpense}
      onClose={onClose}
      onSettled={async () => {
        onClose();
        await onChanged();
      }}
    />
  );
}

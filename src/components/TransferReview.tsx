/**
 * Transfer review: Expenses filed under the Transfer category are data to
 * fix, not data to hide. Until reviewed they count as spending like any
 * other expense. This banner lists each one; resolving is two taps:
 *
 * - "Transfer to one of my accounts": pick the destination, the row
 *   becomes a real Transfer and both balances update.
 * - "Payment to someone": pick the real category, the row stays an
 *   Expense.
 *
 * The queue is a live query: a resolved row no longer matches, so the
 * banner disappears on its own when nothing is left.
 */
import { useCallback, useEffect, useState } from "react";
import { createRepositories } from "../data/repositories/index.js";
import { getActiveDb } from "../data/db.js";
import {
  expenseCategories,
  findTransferCategoryExpenses,
  transferCategoryIds,
} from "../domain/entities/category.js";
import type { Account } from "../domain/entities/account.js";
import type { Category } from "../domain/entities/category.js";
import type { Transaction } from "../domain/entities/transaction.js";
import { formatMoney } from "../app/format.js";
import { convertExpenseToTransfer, recategorizeExpense } from "../app/transferReview.js";

interface ReviewRow {
  tx: Transaction;
  accountName: string;
}

function shortDate(d: string): string {
  const [, m, day] = d.split("-");
  return `${m}/${day}`;
}

function PickList({
  title,
  options,
  onPick,
  onBack,
}: {
  title: string;
  options: { id: string; label: string; sub?: string }[];
  onPick: (id: string) => void;
  onBack: () => void;
}) {
  return (
    <div className="pt-2">
      <div className="flex items-center justify-between px-1 pb-2">
        <p className="text-sm font-medium text-stone-900 dark:text-stone-100">{title}</p>
        <button
          type="button"
          onClick={onBack}
          className="text-sm font-medium text-blue-700 dark:text-blue-300"
        >
          Back
        </button>
      </div>
      <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => onPick(o.id)}
            className="flex items-center justify-between rounded-2xl px-3 py-2.5 text-left transition-colors hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            <span>
              <span className="block text-sm font-medium text-stone-900 dark:text-stone-100">
                {o.label}
              </span>
              {o.sub && (
                <span className="block text-xs text-stone-500 dark:text-stone-400">{o.sub}</span>
              )}
            </span>
            <span aria-hidden className="text-stone-400 dark:text-stone-500">›</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TransferReviewSheet({
  rows,
  accounts,
  categories,
  onClose,
  onResolved,
}: {
  rows: ReviewRow[];
  accounts: Account[];
  categories: Category[];
  onClose: () => void;
  onResolved: () => Promise<void>;
}) {
  const [picking, setPicking] = useState<{ txId: string; mode: "transfer" | "category" } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setWorking(true);
    setError(null);
    try {
      await fn();
      setPicking(null);
      await onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save. Try again.");
    } finally {
      setWorking(false);
    }
  };

  const doConvert = (txId: string, toAccountId: string) =>
    run(() => convertExpenseToTransfer(createRepositories(getActiveDb()), txId, toAccountId).then(() => {}));

  const doRecategorize = (txId: string, categoryId: string | null) =>
    run(() =>
      recategorizeExpense(
        createRepositories(getActiveDb()),
        txId,
        categoryId,
        (id) => transferCategoryIds(categories).has(id),
      ).then(() => {}),
    );

  const pickingRow = picking ? rows.find((r) => r.tx.id === picking.txId) : undefined;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Review transfers">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div className="absolute bottom-0 inset-x-0 mx-auto max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 pb-8 dark:bg-stone-900">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-display text-xl text-stone-900 dark:text-stone-100">
              Review transfers
            </h2>
            <p className="pt-1 text-sm leading-relaxed text-stone-600 dark:text-stone-400">
              These were logged as expenses under Transfer. Sort out whether
              each was a move between your accounts or a payment to someone.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-lg text-stone-500 transition-colors hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800"
          >
            ×
          </button>
        </div>

        {error && (
          <p className="pt-3 text-sm font-medium text-red-600 dark:text-red-400">{error}</p>
        )}

        {picking && pickingRow ? (
          picking.mode === "transfer" ? (
            <PickList
              title="Which account did it go to?"
              options={accounts
                .filter((a) => a.id !== pickingRow.tx.accountId)
                .map((a) => ({
                  id: a.id,
                  label: a.name,
                  sub: a.currency,
                }))}
              onPick={(id) => void doConvert(pickingRow.tx.id, id)}
              onBack={() => setPicking(null)}
            />
          ) : (
            <PickList
              title="What was it really?"
              options={[
                ...categories.map((c) => ({ id: c.id, label: c.name })),
                { id: "__none__", label: "Uncategorized" },
              ]}
              onPick={(id) => void doRecategorize(pickingRow.tx.id, id === "__none__" ? null : id)}
              onBack={() => setPicking(null)}
            />
          )
        ) : (
          <div className="flex flex-col gap-3 pt-4">
            {rows.map(({ tx, accountName }) => (
              <div
                key={tx.id}
                className="rounded-2xl border border-stone-200/70 px-4 py-3 dark:border-stone-800"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
                    {tx.payee || "Transfer"}
                  </p>
                  <p className="shrink-0 font-display text-lg text-stone-900 dark:text-stone-100">
                    {formatMoney(tx.amount, tx.currency)}
                  </p>
                </div>
                <p className="pt-0.5 text-xs text-stone-500 dark:text-stone-400">
                  {shortDate(tx.date)} · {accountName}
                </p>
                <div className="flex gap-2 pt-3">
                  <button
                    type="button"
                    disabled={working}
                    onClick={() => setPicking({ txId: tx.id, mode: "transfer" })}
                    className="flex-1 rounded-xl bg-stone-900 px-3 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-700 disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200"
                  >
                    Transfer to one of my accounts
                  </button>
                  <button
                    type="button"
                    disabled={working}
                    onClick={() => setPicking({ txId: tx.id, mode: "category" })}
                    className="flex-1 rounded-xl border border-stone-300 px-3 py-2.5 text-sm font-medium text-stone-900 transition-colors hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:text-stone-100 dark:hover:bg-stone-800"
                  >
                    Payment to someone
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function TransferReviewBanner({ onChanged }: { onChanged: () => void }) {
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    const repos = createRepositories(getActiveDb());
    const [txs, cats, accts] = await Promise.all([
      repos.transactions.getAll(),
      repos.categories.getAll(),
      repos.accounts.getAll(),
    ]);
    const live = cats.filter((c) => !c.archived);
    const found = findTransferCategoryExpenses(txs, live);
    const acctById = new Map(accts.map((a) => [a.id, a]));
    setRows(
      found.map((tx) => ({
        tx,
        accountName: acctById.get(tx.accountId)?.name ?? "Unknown account",
      })),
    );
    setAccounts(accts.filter((a) => !a.archived));
    setCategories(expenseCategories(live));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (rows && rows.length === 0) setOpen(false);
  }, [rows]);

  if (!rows || rows.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-3xl border border-amber-200 bg-amber-50 px-5 py-4 text-left shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-transform active:scale-[0.99] dark:border-amber-900/40 dark:bg-amber-950/40"
      >
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-800 dark:text-amber-200">
          {rows.length} transfer{rows.length === 1 ? "" : "s"} need{rows.length === 1 ? "s" : ""} review
        </p>
        <p className="pt-1 text-sm leading-relaxed text-amber-900 dark:text-amber-100">
          {rows.length === 1 ? "It was" : "They were"} logged as {rows.length === 1 ? "an expense" : "expenses"} under
          Transfer. Tap to sort out {rows.length === 1 ? "whether it was" : "whether they were"} moves between
          your accounts or payments to someone.
        </p>
      </button>

      {open && (
        <TransferReviewSheet
          rows={rows}
          accounts={accounts}
          categories={categories}
          onClose={() => setOpen(false)}
          onResolved={async () => {
            await refresh();
            onChanged();
          }}
        />
      )}
    </>
  );
}

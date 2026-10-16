/**
 * "Needs review" inbox (Phase B). Every imported row the engine couldn't
 * confidently handle lands here. The transactions already count toward
 * balances — review only fixes up how they're described.
 */
import { useCallback, useEffect, useState } from "react";
import { getActiveDb } from "../data/db.js";
import { createRepositories } from "../data/repositories/index.js";
import type { Account } from "../domain/entities/account.js";
import type { Category } from "../domain/entities/category.js";
import type { RecurringRule } from "../domain/entities/recurringRule.js";
import type { ReviewItem, ReviewReason } from "../domain/entities/reviewItem.js";
import type { Transaction } from "../domain/entities/transaction.js";
import {
  confirmReviewItem,
  confirmTransferPair,
  ignoreReviewItem,
  linkBillReviewItem,
  markTransferReviewItem,
  recategorizeReviewItem,
} from "../app/reviewActions.js";
import { EXTERNAL_ACCOUNT_ID } from "../domain/import/selfTransfers.js";
import { TransactionEditSheet } from "./TransactionEditSheet.js";

function repos() {
  return createRepositories(getActiveDb());
}

const pillCls =
  "shrink-0 rounded-full border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-50 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800 disabled:opacity-50";
const primaryPillCls =
  "shrink-0 rounded-full bg-stone-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200 disabled:opacity-50";
const inputCls =
  "w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100";

const REASON_LABEL: Record<ReviewReason, string> = {
  uncategorized: "Needs a category",
  "ambiguous-match": "Could match several entries",
  "transfer-unconfirmed": "New transfer route",
  "transfer-unknown-account": "Other account unclear",
  "weak-recurring": "Possible subscription",
  "refund-unknown-category": "Refund needs its category",
};

function money(t: Transaction): string {
  const sign = t.type === "Income" || t.type === "Refund" ? "+" : "−";
  return `${sign}$${(t.amount / 100).toFixed(2)}`;
}

interface ItemData {
  item: ReviewItem;
  tx: Transaction;
}

export function ReviewInboxSheet({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<ItemData[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [rules, setRules] = useState<RecurringRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expand, setExpand] = useState<{ id: string; mode: "category" | "transfer" | "bill" } | null>(null);
  const [pick, setPick] = useState("");
  const [always, setAlways] = useState<Record<string, boolean>>({});
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);

  const load = useCallback(async () => {
    const r = repos();
    const [open, accts, cats, rr] = await Promise.all([
      r.reviewItems.open(),
      r.accounts.getAll(),
      r.categories.getAll(),
      r.recurringRules.active(),
    ]);
    const txs = await Promise.all(open.map((i) => r.transactions.getById(i.transactionId)));
    const data: ItemData[] = [];
    open.forEach((item, idx) => {
      const tx = txs[idx];
      if (tx) data.push({ item, tx });
    });
    data.sort((a, b) => (a.tx.date < b.tx.date ? -1 : 1));
    setItems(data);
    setAccounts(accts.filter((a) => !a.archived));
    setCategories(cats.filter((c) => !c.archived));
    setRules(rr.filter((x) => x.kind === "Bill" || x.kind === "Subscription"));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (id: string, fn: () => Promise<void>) => {
      setError(null);
      setWorkingId(id);
      try {
        await fn();
        setExpand(null);
        await load();
        onChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : "That didn't work. Try again.");
      } finally {
        setWorkingId(null);
      }
    },
    [load, onChanged],
  );

  const guessLine = (d: ItemData): string => {
    const g = d.item.guess;
    const cat = g.categoryId ? categories.find((c) => c.id === g.categoryId)?.name : null;
    const dest = g.transferToAccountId
      ? accounts.find((a) => a.id === g.transferToAccountId)?.name
      : null;
    if (g.type === "Transfer") return `Transfer${dest ? ` → ${dest}` : ""}`;
    return `${g.type}${cat ? ` · ${cat}` : ""}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center">
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white p-5 dark:bg-stone-900 sm:rounded-3xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">Needs review</h2>
          <button type="button" onClick={onClose} className={pillCls} aria-label="Close">
            Done
          </button>
        </div>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          These already count in your balances. Review just tidies how they're described.
        </p>

        {loading && <p className="mt-4 text-sm text-stone-500">Loading…</p>}
        {error && <p className="mt-3 text-sm text-red-700 dark:text-red-300">{error}</p>}

        {!loading && items.length === 0 && (
          <p className="mt-4 text-sm text-stone-600 dark:text-stone-300">
            All clear. Nothing needs review.
          </p>
        )}

        <ul className="mt-4 space-y-3">
          {items.map((d) => {
            const busy = workingId === d.item.id;
            const isTransfer = d.item.reasons.includes("transfer-unconfirmed");
            return (
              <li
                key={d.item.id}
                className="rounded-2xl border border-stone-200 p-3 dark:border-stone-700"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-stone-900 dark:text-stone-100">
                      {d.tx.payee}
                    </span>
                    <span className="text-xs text-stone-500 dark:text-stone-400">
                      {d.tx.date} · Best guess: {guessLine(d)}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold text-stone-900 dark:text-stone-100">
                    {money(d.tx)}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {d.item.reasons.map((r) => (
                    <span
                      key={r}
                      className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] text-stone-600 dark:bg-stone-800 dark:text-stone-300"
                    >
                      {REASON_LABEL[r]}
                    </span>
                  ))}
                </div>

                <label className="mt-2 flex items-center gap-2 text-xs text-stone-600 dark:text-stone-300">
                  <input
                    type="checkbox"
                    checked={!!always[d.item.id]}
                    onChange={(e) => setAlways((s) => ({ ...s, [d.item.id]: e.target.checked }))}
                  />
                  Always do this for {d.item.merchantKey.toLowerCase()}
                </label>

                <div className="mt-2 flex flex-wrap gap-1.5">
                  {isTransfer ? (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        className={primaryPillCls}
                        onClick={() => void run(d.item.id, () => confirmTransferPair(repos(), d.item.id, false))}
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className={pillCls}
                        onClick={() => void run(d.item.id, () => confirmTransferPair(repos(), d.item.id, true))}
                      >
                        Always for this route
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      className={primaryPillCls}
                      onClick={() =>
                        void run(d.item.id, () => confirmReviewItem(repos(), d.item.id, !!always[d.item.id]))
                      }
                    >
                      Confirm
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    className={pillCls}
                    onClick={() => {
                      setPick(d.item.guess.categoryId ?? "");
                      setExpand({ id: d.item.id, mode: "category" });
                    }}
                  >
                    Category
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={pillCls}
                    onClick={() => {
                      setPick("");
                      setExpand({ id: d.item.id, mode: "transfer" });
                    }}
                  >
                    Transfer
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={pillCls}
                    onClick={() => {
                      setPick("");
                      setExpand({ id: d.item.id, mode: "bill" });
                    }}
                  >
                    Bill
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={pillCls}
                    onClick={() => setEditingTx(d.tx)}
                  >
                    Split / IOU
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={pillCls}
                    onClick={() => void run(d.item.id, () => ignoreReviewItem(repos(), d.item.id))}
                  >
                    Ignore
                  </button>
                </div>

                {expand?.id === d.item.id && (
                  <div className="mt-2 flex gap-2">
                    {expand.mode === "category" && (
                      <select
                        className={inputCls}
                        value={pick}
                        onChange={(e) => setPick(e.target.value)}
                        aria-label="Pick a category"
                      >
                        <option value="">Pick a category…</option>
                        {categories
                          .filter((c) => c.kind === "expense")
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                      </select>
                    )}
                    {expand.mode === "transfer" && (
                      <select
                        className={inputCls}
                        value={pick}
                        onChange={(e) => setPick(e.target.value)}
                        aria-label="Pick the destination account"
                      >
                        <option value="">To which account…</option>
                        <option value={EXTERNAL_ACCOUNT_ID}>External account (not in the app)</option>
                        {accounts
                          .filter((a) => a.id !== d.tx.accountId)
                          .map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                      </select>
                    )}
                    {expand.mode === "bill" && (
                      <select
                        className={inputCls}
                        value={pick}
                        onChange={(e) => setPick(e.target.value)}
                        aria-label="Pick the bill"
                      >
                        <option value="">This is my… bill</option>
                        {rules.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                    )}
                    <button
                      type="button"
                      disabled={busy || !pick}
                      className={primaryPillCls}
                      onClick={() => {
                        const mode = expand.mode;
                        const value = pick;
                        void run(d.item.id, () => {
                          if (mode === "category")
                            return recategorizeReviewItem(repos(), d.item.id, value, undefined, !!always[d.item.id]);
                          if (mode === "transfer") return markTransferReviewItem(repos(), d.item.id, value);
                          return linkBillReviewItem(repos(), d.item.id, value);
                        });
                      }}
                    >
                      Apply
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {editingTx && (
          <TransactionEditSheet
            tx={editingTx}
            accounts={accounts}
            categories={categories}
            onClose={() => setEditingTx(null)}
            onSaved={async () => {
              const txId = editingTx.id;
              setEditingTx(null);
              await run(txId, async () => {
                // Splitting/IOU happens in the editor; just clear the item.
                const r = repos();
                const byTx = await r.reviewItems.byTransaction(txId);
                for (const it of byTx.filter((x) => x.status === "open")) {
                  await r.reviewItems.put({ ...it, status: "resolved", resolvedAt: new Date().toISOString() });
                }
              });
            }}
            onDelete={async () => setEditingTx(null)}
            onSkip={async () => setEditingTx(null)}
            occurrenceTaken={() => false}
          />
        )}
      </div>
    </div>
  );
}

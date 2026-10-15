/**
 * Balance-correction dialog for ?adjust= deep links. Shows the app's
 * derived balance next to the stated balance and — only on explicit
 * confirm — records the difference as a single Unlogged spending
 * (Expense) or Unlogged income (Income) entry through the normal
 * saveQuickLog path. The balance itself is never silently overwritten:
 * both numbers are always on screen.
 */
import { useEffect, useState } from "react";
import { createRepositories, type Repositories } from "../data/repositories/index.js";
import { getDb } from "../data/db.js";
import { saveQuickLog } from "../app/quickLog.js";
import { formatMoney } from "../app/format.js";
import { todayLocal } from "../domain/dates/dateOnly.js";
import type { Account } from "../domain/entities/account.js";
import type { Category, CategoryKind } from "../domain/entities/category.js";
import type { MinorUnits } from "../domain/money/money.js";
import { deriveBalances } from "../domain/engine/balances.js";
import {
  decideAdjust,
  parseBalanceToMinor,
  type AdjustDecision,
  type AdjustIntent,
} from "../utils/deepLink.js";

const UNCATEGORIZED = "Uncategorized";

/**
 * Find or create the catch-all category for balance corrections:
 * "Uncategorized" of the right kind when present, otherwise any live
 * category of that kind, otherwise a new "Uncategorized".
 */
async function ensureCorrectionCategory(
  repos: Repositories,
  kind: CategoryKind,
): Promise<string> {
  const cats = await repos.categories.getAll();
  const live = cats.filter((c) => !c.archived && c.kind === kind);
  const named = live.find((c) => c.name.trim().toLowerCase() === UNCATEGORIZED.toLowerCase());
  if (named) return named.id;
  if (kind === "income") {
    const income = live.find((c) => c.name.trim().toLowerCase() === "income");
    if (income) return income.id;
  }
  const any = live[0];
  if (any) return any.id;
  const created: Category = {
    id: crypto.randomUUID(),
    name: UNCATEGORIZED,
    kind,
    icon: "dots",
    color: "slate",
    archived: false,
  };
  await repos.categories.put(created);
  return created.id;
}

type Loaded =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      account: Account;
      appBalance: MinorUnits;
      statedMinor: MinorUnits;
      decision: AdjustDecision;
    };

export function DeepLinkAdjust({
  intent,
  accountId,
  onClose,
  onApplied,
}: {
  intent: AdjustIntent;
  accountId: string;
  onClose: () => void;
  onApplied: (message: string) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const repos = createRepositories(getDb());
        const [accounts, transactions] = await Promise.all([
          repos.accounts.getAll(),
          repos.transactions.getAll(),
        ]);
        if (cancelled) return;
        const account = accounts.find((a) => a.id === accountId) ?? null;
        if (!account) {
          setLoaded({ status: "error", message: "That account is gone — nothing was recorded." });
          return;
        }
        const balances = deriveBalances(accounts, transactions);
        const appBalance = balances[account.id] ?? account.startingBalance;
        const statedMinor = parseBalanceToMinor(intent.balanceText, account.currency);
        if (statedMinor === null) {
          setLoaded({
            status: "error",
            message: `"${intent.balanceText}" doesn't fit ${account.currency} — nothing was recorded.`,
          });
          return;
        }
        setLoaded({
          status: "ready",
          account,
          appBalance,
          statedMinor,
          decision: decideAdjust(appBalance, statedMinor),
        });
      } catch (e) {
        if (!cancelled) {
          setLoaded({
            status: "error",
            message: e instanceof Error ? e.message : "Couldn't load the account.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, intent]);

  const confirm = async () => {
    if (loaded.status !== "ready") return;
    if (loaded.decision.kind === "match") return;
    const spending = loaded.decision.kind === "spending";
    setSaving(true);
    setSaveError(null);
    try {
      const repos = createRepositories(getDb());
      const categoryId = await ensureCorrectionCategory(
        repos,
        spending ? "expense" : "income",
      );
      await saveQuickLog(repos, {
        type: spending ? "Expense" : "Income",
        amountMinor: loaded.decision.differenceMinor,
        accountId: loaded.account.id,
        categoryId,
        payee: spending ? "Unlogged spending" : "Unlogged income",
        date: todayLocal(),
      });
      onApplied(
        spending
          ? `Recorded ${formatMoney(loaded.decision.differenceMinor, loaded.account.currency)} unlogged spending.`
          : `Recorded ${formatMoney(loaded.decision.differenceMinor, loaded.account.currency)} unlogged income.`,
      );
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Couldn't record it. Try again.");
      setSaving(false);
    }
  };

  const body = (() => {
    if (loaded.status === "loading") {
      return (
        <div className="flex items-center justify-center py-8">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-stone-300 border-t-stone-800 dark:border-stone-600 dark:border-t-stone-200" />
        </div>
      );
    }
    if (loaded.status === "error") {
      return <p className="py-2 text-sm text-stone-600 dark:text-stone-400">{loaded.message}</p>;
    }
    const { account, appBalance, statedMinor, decision } = loaded;
    const fmt = (m: MinorUnits) => formatMoney(m, account.currency);
    if (decision.kind === "match") {
      return (
        <p className="py-2 text-sm text-stone-600 dark:text-stone-400">
          {account.name} already matches {fmt(statedMinor)} — nothing to record.
        </p>
      );
    }
    const spending = decision.kind === "spending";
    return (
      <>
        <p className="py-2 text-sm text-stone-600 dark:text-stone-400">
          {account.name} is {fmt(appBalance)} in the app, you say {fmt(statedMinor)}. Record
          the {fmt(decision.differenceMinor)} difference as{" "}
          {spending ? "Unlogged spending" : "Unlogged income"}?
        </p>
        {saveError && (
          <p className="text-sm font-medium text-red-700 dark:text-red-300">{saveError}</p>
        )}
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={saving}
            className="flex-1 rounded-full bg-stone-900 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-700 disabled:opacity-60 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200"
          >
            {saving ? "Recording…" : "Record it"}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="flex-1 rounded-full border border-stone-300 bg-white py-2.5 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-60 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-300 dark:hover:bg-stone-800"
          >
            Cancel
          </button>
        </div>
      </>
    );
  })();

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Balance correction">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div className="absolute inset-x-0 bottom-0 mx-auto w-full max-w-md rounded-t-3xl bg-white p-5 pb-8 dark:bg-stone-900">
        <div className="flex items-start justify-between">
          <h2 className="font-display text-xl text-stone-900 dark:text-stone-100">
            Correct balance
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close balance correction"
            className="flex h-8 w-8 items-center justify-center rounded-full text-lg text-stone-500 transition-colors hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800"
          >
            ×
          </button>
        </div>
        <div className="mt-3 flex flex-col gap-3">{body}</div>
        {loaded.status !== "ready" && loaded.status !== "loading" && (
          <button
            type="button"
            onClick={onClose}
            className="mt-4 w-full rounded-full border border-stone-300 bg-white py-2.5 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-300 dark:hover:bg-stone-800"
          >
            Close
          </button>
        )}
      </div>
    </div>
  );
}

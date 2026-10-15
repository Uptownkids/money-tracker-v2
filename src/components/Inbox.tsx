/**
 * Private inbox UI (Step 2). Rocky writes entries to the private
 * money-inbox repo; Malike approves them here on his phone.
 *
 * - Hidden entirely when no inbox token is set (or in demo mode).
 * - Token expiry is surfaced as a banner, never a silent empty inbox:
 *   expired -> "Inbox token expired — update it in Settings."; expiring
 *   within 14 days -> "Inbox token expires in N days — update it in
 *   Settings." A 401/403 from GitHub shows the expired banner too.
 * - Entries older than 60 days that were never applied get a persistent
 *   warning banner on launch and on refresh.
 * - Approving an expense/income opens Quick-Log prefilled (normal Save
 *   path: bill matching and duplicate checks unchanged; nothing saves
 *   until he taps Save). Approving an adjust opens the same
 *   balance-correction flow as the ?adjust= link. Dismissing without
 *   saving leaves the entry pending.
 * - The phone only ever GETs the inbox file. Nothing is uploaded.
 */
import { useCallback, useEffect, useState } from "react";
import { createRepositories } from "../data/repositories/index.js";
import { getDb, isDemoMode } from "../data/db.js";
import { getAppliedInboxIds } from "../data/inbox.js";
import { matchAccountName } from "../utils/deepLink.js";
import type { AdjustIntent } from "../utils/deepLink.js";
import {
  daysUntilTokenExpiry,
  fetchInbox,
  getInboxToken,
  getInboxTokenExpiry,
  inboxAdjustToIntent,
  inboxTokenStatus,
  staleInboxEntries,
  type InboxEntry,
  type InboxFetchError,
} from "../utils/inbox.js";
import type { QuickLogPrefill } from "./QuickLog.js";
import { formatMoney } from "../app/format.js";
import { todayLocal, type DateOnly } from "../domain/dates/dateOnly.js";
import type { MinorUnits } from "../domain/money/money.js";

/** Dollars (JSON number) -> validated decimal text for prefill/intent. */
function dollarsToText(n: number): string {
  return String(Math.round(n * 1e9) / 1e9);
}

function dollarsToMinor(n: number): MinorUnits {
  return Math.round(n * 100) as MinorUnits;
}

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: InboxFetchError }
  | { status: "ready"; entries: InboxEntry[]; appliedIds: string[]; baseCurrency: string };

function Banner({
  tone,
  children,
  actionLabel,
  onAction,
}: {
  tone: "amber" | "red";
  children: React.ReactNode;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const cls =
    tone === "red"
      ? "bg-red-50 ring-red-200 dark:bg-red-950 dark:ring-red-800"
      : "bg-amber-50 ring-amber-200 dark:bg-amber-950 dark:ring-amber-800";
  const textCls =
    tone === "red"
      ? "text-red-800 dark:text-red-200"
      : "text-amber-800 dark:text-amber-200";
  return (
    <div className={`flex items-center justify-between gap-3 rounded-2xl px-4 py-3 ring-1 ring-inset ${cls}`}>
      <p className={`text-sm ${textCls}`}>{children}</p>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="shrink-0 rounded-full bg-stone-900 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export function InboxSection({
  refreshKey,
  onPrefill,
  onAdjust,
  onOpenSettings,
}: {
  refreshKey: number;
  onPrefill: (prefill: QuickLogPrefill) => void;
  onAdjust: (intent: AdjustIntent, accountId: string, inboxEntryId: string) => void;
  onOpenSettings: () => void;
}) {
  const [load, setLoad] = useState<LoadState>({ status: "idle" });
  const [tokenTick, setTokenTick] = useState(0);
  const [approveError, setApproveError] = useState<string | null>(null);

  const token = getInboxToken();
  const expiry = getInboxTokenExpiry();
  const today = todayLocal();
  const tokenStatus = inboxTokenStatus(token, expiry, today);

  const reload = useCallback(() => {
    setTokenTick((t) => t + 1);
  }, []);

  useEffect(() => {
    if (!token || isDemoMode()) {
      setLoad({ status: "idle" });
      return;
    }
    let cancelled = false;
    setLoad({ status: "loading" });
    void (async () => {
      const repos = createRepositories(getDb());
      const [result, appliedIds, settings] = await Promise.all([
        fetchInbox(token),
        getAppliedInboxIds(repos),
        repos.settings.get(),
      ]);
      if (cancelled) return;
      if (!result.ok) {
        setLoad({ status: "error", error: result.error });
        return;
      }
      setLoad({
        status: "ready",
        entries: result.entries,
        appliedIds,
        baseCurrency: settings?.baseCurrency ?? "USD",
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, tokenTick, token]);

  // No token, or demo mode: the inbox doesn't exist here.
  if (!token || isDemoMode()) return null;

  const daysLeft = daysUntilTokenExpiry(expiry, today);

  const approveEntry = async (entry: InboxEntry) => {
    setApproveError(null);
    const repos = createRepositories(getDb());
    const accounts = await repos.accounts.active();
    const matched = matchAccountName(
      accounts.map((a) => a.name),
      entry.account,
    );
    if (!matched.ok) {
      setApproveError(`Couldn't approve this entry: ${matched.error}.`);
      return;
    }
    const account = accounts.find((a) => a.name === matched.name);
    if (!account) {
      setApproveError(`Couldn't approve this entry: account "${entry.account}" not found.`);
      return;
    }
    if (entry.kind === "adjust") {
      if (entry.balance === undefined) {
        setApproveError("Couldn't approve this entry: it's missing a balance.");
        return;
      }
      // Same AdjustIntent a ?adjust= link produces — shared approval flow.
      onAdjust(inboxAdjustToIntent(entry), account.id, entry.id);
      return;
    }
    if (entry.amount === undefined || entry.payee === undefined) {
      setApproveError("Couldn't approve this entry: it's missing an amount or payee.");
      return;
    }
    onPrefill({
      type: entry.kind === "income" ? "Income" : "Expense",
      amount: dollarsToText(entry.amount),
      payee: entry.payee,
      accountId: account.id,
      date: entry.date,
      inboxEntryId: entry.id,
    });
  };

  const pending =
    load.status === "ready"
      ? load.entries.filter((e) => !load.appliedIds.includes(e.id))
      : [];
  const stale =
    load.status === "ready" ? staleInboxEntries(load.entries, load.appliedIds, today) : [];
  const baseCurrency = load.status === "ready" ? load.baseCurrency : "USD";

  const renderEntry = (entry: InboxEntry) => {
    const isAdjust = entry.kind === "adjust";
    const headline = isAdjust
      ? "Balance check"
      : `${entry.kind === "income" ? "+" : "−"}${formatMoney(dollarsToMinor(entry.amount ?? 0), baseCurrency)} ${entry.payee ?? ""}`;
    const sub = isAdjust
      ? `${entry.account} · you say ${formatMoney(dollarsToMinor(entry.balance ?? 0), baseCurrency)}`
      : `${entry.account} · ${entry.date}`;
    return (
      <li
        key={entry.id}
        className="flex items-center justify-between gap-3 rounded-2xl bg-stone-50 px-4 py-3 dark:bg-stone-800/60"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-stone-900 dark:text-stone-100">
            {headline.trim()}
          </p>
          <p className="truncate text-xs text-stone-500 dark:text-stone-400">{sub}</p>
          {entry.note && (
            <p className="truncate text-xs italic text-stone-400 dark:text-stone-500">
              {entry.note}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void approveEntry(entry)}
          className="shrink-0 rounded-full bg-stone-900 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200"
        >
          Approve
        </button>
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      {tokenStatus === "expired" && (
        <Banner tone="red" actionLabel="Open Settings" onAction={onOpenSettings}>
          Inbox token expired — update it in Settings.
        </Banner>
      )}
      {tokenStatus === "expiring" && daysLeft !== null && (
        <Banner tone="amber" actionLabel="Open Settings" onAction={onOpenSettings}>
          Inbox token expires in {daysLeft} {daysLeft === 1 ? "day" : "days"} — update it in
          Settings.
        </Banner>
      )}
      {load.status === "error" && load.error.kind === "auth" && tokenStatus !== "expired" && (
        <Banner tone="red" actionLabel="Open Settings" onAction={onOpenSettings}>
          GitHub rejected the inbox token — update it in Settings.
        </Banner>
      )}
      {load.status === "error" && load.error.kind !== "auth" && (
        <Banner tone="amber" actionLabel="Retry" onAction={reload}>
          {load.error.kind === "network"
            ? "Couldn't reach the inbox — check your connection."
            : `Inbox couldn't load: ${load.error.message}`}
        </Banner>
      )}
      {stale.length > 0 && (
        <Banner tone="amber">
          {stale.length} inbox {stale.length === 1 ? "entry is" : "entries are"} over 60 days
          old — review {stale.length === 1 ? "it" : "them"}.
        </Banner>
      )}
      {approveError && (
        <div className="rounded-2xl bg-red-50 px-4 py-3 ring-1 ring-inset ring-red-200 dark:bg-red-950 dark:ring-red-800">
          <p className="text-sm text-red-800 dark:text-red-200">{approveError}</p>
        </div>
      )}

      {(load.status === "ready" || load.status === "loading") && (
        <section aria-label="Inbox" className="rounded-3xl bg-white p-4 ring-1 ring-inset ring-stone-200 dark:bg-stone-900 dark:ring-stone-800">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg text-stone-900 dark:text-stone-100">
              Inbox{" "}
              {pending.length > 0 && (
                <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-stone-900 px-1.5 text-[11px] font-semibold text-white dark:bg-stone-100 dark:text-stone-900">
                  {pending.length}
                </span>
              )}
            </h2>
            <button
              type="button"
              onClick={reload}
              aria-label="Refresh inbox"
              className="flex h-8 w-8 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800"
            >
              ⟳
            </button>
          </div>
          {load.status === "loading" ? (
            <p className="py-3 text-sm text-stone-500 dark:text-stone-400">Checking inbox…</p>
          ) : pending.length === 0 ? (
            <p className="py-3 text-sm text-stone-500 dark:text-stone-400">
              Nothing waiting — new entries from Rocky show up here for your approval.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {pending.map(renderEntry)}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

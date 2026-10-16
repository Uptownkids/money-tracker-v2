/**
 * Money Tracker v2 — Phase 6 app shell.
 * Six tabs: Dashboard (hero, payday banner, today's moves, balances,
 * coming up, IOUs), Log (full transaction feed), Bills (recurring rules),
 * Goals, Accounts, Insights. Quick-log FAB is mounted once and shows on
 * every tab. The Payday Run guided checklist opens as a full-screen
 * overlay from the Dashboard banner (when a payday is due) or the Bills
 * tab. First launch shows the Onboarding flow (welcome / fresh wizard /
 * v1 migration) until the onboarding flag is set. Settings live behind
 * the header gear.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { loadDashboardState, type DashboardState } from "./dashboard.js";
import { resolvePaydayRunTarget, type PaydayRunTarget } from "./paydayRunEntry.js";
import type { DateOnly } from "../domain/dates/dateOnly.js";
import { compareDateOnly, todayLocal } from "../domain/dates/dateOnly.js";
import { createRepositories } from "../data/repositories/index.js";
import { getActiveDb, getDb, isDemoMode, setDemoMode } from "../data/db.js";
import { parseDeepLink, type AdjustIntent } from "../utils/deepLink.js";
import {
  billMoveRef,
  markStaleCleared,
  settleBillMove,
} from "../domain/engine/moveActions.js";
import type { TodaysMove } from "../domain/engine/todaysMoves.js";
import type { Transaction } from "../domain/entities/transaction.js";
import { applyTheme, watchSystemTheme } from "./theme.js";
import { maybeNotifyUpcomingBills } from "./notifications.js";
import { markOnboardingComplete, shouldShowOnboarding } from "./onboarding.js";
import { TodayCards } from "../components/TodayCards.js";
import { BalancesList } from "../components/BalancesList.js";
import { TodaysMoves } from "../components/TodaysMoves.js";
import { BillMoveSheet, IouMoveSheet } from "../components/MoveSheets.js";
import { DemoBanner } from "../components/DemoBanner.js";
import { QuickLog, type QuickLogPrefill } from "../components/QuickLog.js";
import { DeepLinkAdjust } from "../components/DeepLinkAdjust.js";
import { InboxSection } from "../components/Inbox.js";
import { markInboxEntryApplied } from "../data/inbox.js";
import { EverythingLog } from "../components/EverythingLog.js";
import { Accounts } from "../components/Accounts.js";
import { RecurringRules } from "../components/RecurringRules.js";
import { Goals } from "../components/Goals.js";
import { Upcoming } from "../components/Upcoming.js";
import { Ious } from "../components/Ious.js";
import { Insights } from "../components/Insights.js";
import { History } from "../components/History.js";
import { Onboarding } from "../components/Onboarding.js";
import { SettingsSheet, BackupBanner } from "../components/Settings.js";
import { TransferReviewBanner } from "../components/TransferReview.js";
import { PaydayRun } from "../components/PaydayRun.js";
import { ReviewInboxSheet } from "../components/ReviewInbox.js";
import { applySwUpdate, onSwUpdate } from "./swUpdates.js";
import { requestPersistentStorage } from "./persistentStorage.js";
import { loadDemoData } from "./seed.js";

type Tab = "dashboard" | "log" | "bills" | "goals" | "accounts" | "insights" | "history";

const TABS: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "log", label: "Log" },
  { id: "bills", label: "Bills" },
  { id: "goals", label: "Goals" },
  { id: "accounts", label: "Accounts" },
  { id: "insights", label: "Insights" },
  { id: "history", label: "History" },
];

function Loading() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-stone-300 border-t-stone-800 dark:border-stone-600 dark:border-t-stone-200" />
    </div>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-8 text-center">
      <p className="font-display text-2xl text-stone-900 dark:text-stone-100">Something didn&rsquo;t load.</p>
      <p className="text-sm text-stone-600 dark:text-stone-400">Your data is safe on this device. Try again.</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-full bg-stone-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200"
      >
        Retry
      </button>
    </div>
  );
}

function EmptyState({ onLoadDemo }: { onLoadDemo: () => void }) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 px-8 text-center">
      <p className="font-display text-2xl text-stone-900 dark:text-stone-100">No accounts yet.</p>
      <p className="text-sm text-stone-600 dark:text-stone-400">
        Add your first account to start tracking, or explore with sample data.
      </p>
      <button
        type="button"
        onClick={onLoadDemo}
        className="rounded-full bg-stone-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200"
      >
        Load demo
      </button>
    </div>
  );
}

function FxWarningBanner({ currencies }: { currencies: string[] }) {
  if (currencies.length === 0) return null;
  return (
    <div className="rounded-2xl bg-amber-50 px-4 py-2.5 ring-1 ring-inset ring-amber-200 dark:bg-amber-950 dark:ring-amber-800">
      <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
        No exchange rate for {currencies.join(", ")} — those amounts are shown
        unconverted. Set a rate on the account to fix this.
      </p>
    </div>
  );
}

function PaydayBanner({
  state,
  onStart,
  resolveError,
}: {
  state: DashboardState;
  onStart: (payDate: DateOnly) => void;
  resolveError: string | null;
}) {
  const { nextPayday, today } = state;
  if (!nextPayday || compareDateOnly(nextPayday, today) > 0) return null;
  const overdue = compareDateOnly(nextPayday, today) < 0;
  return (
    <div className="rounded-2xl bg-stone-900 px-4 py-3.5 text-white dark:bg-stone-100 dark:text-stone-900">
      <p className="font-display text-lg">
        {overdue ? "Payday landed — run the checklist" : "Payday is today"}
      </p>
      <p className="mt-0.5 text-xs text-stone-300 dark:text-stone-600">
        Confirm the check, set aside bills, fund goals, pay cards.
      </p>
      <button
        type="button"
        onClick={() => onStart(nextPayday)}
        className="mt-2.5 rounded-full bg-white px-5 py-2 text-sm font-medium text-stone-900 transition-colors hover:bg-stone-200 dark:bg-stone-900 dark:text-stone-100 dark:hover:bg-stone-800"
      >
        Start payday run
      </button>
      {resolveError && (
        <p className="mt-2 text-xs text-amber-200 dark:text-amber-800">{resolveError}</p>
      )}
    </div>
  );
}

function GearIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/**
 * Persistent deep-link notices. The parse-error panel states exactly what
 * was wrong with the link; the not-ready panel explains the iOS storage
 * split (installed app vs Safari keep separate data). Both are
 * dismissible and never auto-hide.
 */
function DeepLinkErrorPanel({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div
      role="alert"
      className="rounded-2xl bg-red-50 px-4 py-3.5 ring-1 ring-inset ring-red-200 dark:bg-red-950 dark:ring-red-800"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-red-900 dark:text-red-100">
            Couldn&rsquo;t open this link
          </p>
          <p className="mt-0.5 text-sm text-red-700 dark:text-red-300">{message}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-full border border-red-300 px-3.5 py-1.5 text-xs font-medium text-red-800 transition-colors hover:bg-red-100 dark:border-red-700 dark:text-red-200 dark:hover:bg-red-900"
        >
          Close
        </button>
      </div>
    </div>
  );
}

function DeepLinkNotReadyPanel({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="alert"
      className="rounded-2xl bg-stone-200/70 px-4 py-3.5 ring-1 ring-inset ring-stone-300 dark:bg-stone-800 dark:ring-stone-700"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
            No tracker data in this browser
          </p>
          <p className="mt-0.5 text-sm text-stone-600 dark:text-stone-400">
            Your iPhone keeps the installed app&rsquo;s data separate from Safari, so this
            browser doesn&rsquo;t see your tracker yet. Links work when opened in the same
            browser where your data lives.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-full border border-stone-300 px-3.5 py-1.5 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-300/50 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-700"
        >
          Close
        </button>
      </div>
    </div>
  );
}

function DeepLinkNotices({
  error,
  notReady,
  onCloseError,
  onCloseNotReady,
}: {
  error: string | null;
  notReady: boolean;
  onCloseError: () => void;
  onCloseNotReady: () => void;
}) {
  if (!error && !notReady) return null;
  return (
    <div className="flex flex-col gap-3">
      {notReady && <DeepLinkNotReadyPanel onClose={onCloseNotReady} />}
      {error && <DeepLinkErrorPanel message={error} onClose={onCloseError} />}
    </div>
  );
}

/** Fixed top banner shown when a new service worker version is waiting. */
function SwUpdateBanner() {
  return (
    <div className="fixed inset-x-0 top-0 z-50 px-4 pt-[env(safe-area-inset-top)]">
      <div className="mx-auto mt-3 flex w-full max-w-md items-center justify-between gap-3 rounded-2xl bg-stone-900 px-4 py-3 shadow-lg ring-1 ring-stone-700 dark:bg-stone-100 dark:ring-stone-300">
        <p className="text-sm font-medium text-white dark:text-stone-900">New version available</p>
        <button
          type="button"
          onClick={applySwUpdate}
          className="shrink-0 rounded-full bg-white px-4 py-1.5 text-xs font-medium text-stone-900 transition-colors hover:bg-stone-200 dark:bg-stone-900 dark:text-white dark:hover:bg-stone-700"
        >
          Reload
        </button>
      </div>
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [paydayRun, setPaydayRun] = useState<PaydayRunTarget | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  // Today's Moves one-tap state.
  const [billEditTx, setBillEditTx] = useState<Transaction | null>(null);
  const [iouSplitId, setIouSplitId] = useState<string | null>(null);
  const [billsEditRuleId, setBillsEditRuleId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  // Settings sheet.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // First-launch onboarding gate.
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  // Service worker update banner.
  const [swUpdateAvailable, setSwUpdateAvailable] = useState(false);
  // Persistent storage request on app start (navigator.storage.persist()).
  // Null until the browser answers; Settings shows the granted state.
  const [storagePersisted, setStoragePersisted] = useState<boolean | null>(null);
  // One-tap deep links (?add= / ?adjust=).
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);
  const [deepLinkNotReady, setDeepLinkNotReady] = useState(false);
  const [quickLogPrefill, setQuickLogPrefill] = useState<QuickLogPrefill | null>(null);
  const [adjustDialog, setAdjustDialog] = useState<{
    intent: AdjustIntent;
    accountId: string;
  } | null>(null);
  // Private inbox (Step 2): refreshKey bumps to refetch; pendingInboxAdjustId
  // tracks an adjust entry being approved so it can be marked applied once
  // the correction is recorded (dismissing without confirming leaves it pending).
  const [inboxRefreshKey, setInboxRefreshKey] = useState(0);
  const [pendingInboxAdjustId, setPendingInboxAdjustId] = useState<string | null>(null);

  // Service worker updates: show the banner when a new version is waiting.
  // onSwUpdate fires immediately if an update is already waiting, so late
  // subscribers never miss it.
  useEffect(() => onSwUpdate(() => setSwUpdateAvailable(true)), []);

  // Ask the browser to keep this origin's IndexedDB under storage
  // pressure. Idempotent; safe under StrictMode's double-invoked effects.
  useEffect(() => {
    let alive = true;
    void requestPersistentStorage().then((granted) => {
      if (alive) setStoragePersisted(granted);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  }, []);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const openPaydayRun = useCallback(async (payDate: DateOnly) => {
    setResolveError(null);
    const target = await resolvePaydayRunTarget(payDate);
    if (target) {
      setPaydayRun(target);
    } else {
      setResolveError("Set a primary payday in the Bills tab first.");
    }
  }, []);

  const pauseGoal = useCallback(
    async (goalId: string) => {
      const repos = createRepositories(getActiveDb());
      const goal = await repos.goals.getById(goalId);
      if (goal && !goal.paused) {
        await repos.goals.put({ ...goal, paused: true, updatedAt: new Date().toISOString() });
        reload();
      }
    },
    [reload],
  );

  /** One-tap "Mark paid" / "Mark cleared" for a Today's Move. */
  const markMovePaid = useCallback(
    async (move: TodaysMove) => {
      const repos = createRepositories(getActiveDb());
      const nowIso = new Date().toISOString();
      if (move.kind === "stale-pending") {
        const transactions = await repos.transactions.getAll();
        const { cleared } = markStaleCleared(transactions, move.relatedId, nowIso);
        if (!cleared) {
          showToast("That transaction is already cleared");
          return;
        }
        await repos.transactions.put(cleared);
        showToast("Marked cleared");
        reload();
        return;
      }
      const [transactions, rules] = await Promise.all([
        repos.transactions.getAll(),
        repos.recurringRules.getAll(),
      ]);
      let settlement;
      try {
        settlement = settleBillMove(transactions, rules, move, todayLocal(), nowIso);
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Couldn't mark it paid");
        return;
      }
      const { settled, created } = settlement;
      if (settled) {
        await repos.transactions.put(settled);
      } else if (created) {
        await repos.transactions.put(created);
      } else {
        showToast("Couldn't find that bill");
        return;
      }
      showToast("Marked paid");
      reload();
    },
    [reload, showToast],
  );

  /** "Snooze" hides the move until tomorrow; the row persists in Dexie. */
  const snoozeMove = useCallback(
    async (move: TodaysMove) => {
      const repos = createRepositories(getActiveDb());
      await repos.snoozedMoves.put({
        moveId: move.id,
        snoozedUntil: todayLocal(),
      });
      showToast("Snoozed until tomorrow");
      reload();
    },
    [reload, showToast],
  );

  /** Row tap: open the move's sheet or land on its tab. */
  const openMove = useCallback(
    async (move: TodaysMove) => {
      switch (move.kind) {
        case "payday-run":
          if (state) void openPaydayRun(state.today);
          return;
        case "stale-pending":
          setTab("log");
          return;
        case "old-iou":
          setIouSplitId(move.relatedId);
          return;
        case "goal-past-due":
          setTab("goals");
          return;
        case "unused-subscription":
          setBillsEditRuleId(move.relatedId);
          setTab("bills");
          return;
        case "needs-review":
          setReviewOpen(true);
          return;
        case "overdue-bill":
        case "bill-due-soon": {
          const ref = billMoveRef(move);
          if (!ref) {
            showToast("Couldn't open that bill");
            return;
          }
          const repos = createRepositories(getActiveDb());
          if (ref.kind === "tx") {
            const tx = await repos.transactions.getById(ref.txId);
            if (tx) setBillEditTx(tx);
            else showToast("Couldn't open that bill");
            return;
          }
          const tx = await repos.transactions.byRuleOccurrence(
            ref.ruleId,
            ref.occurrenceDate,
          );
          if (tx) {
            setBillEditTx(tx);
          } else {
            // No generated row yet (a future occurrence): open the
            // rule's edit sheet on the Bills tab instead.
            const rule = await repos.recurringRules.getById(ref.ruleId);
            if (rule) {
              setBillsEditRuleId(rule.id);
              setTab("bills");
            } else {
              showToast("Couldn't open that bill");
            }
          }
          return;
        }
      }
    },
    [state, openPaydayRun, showToast],
  );

  const load = useCallback(async () => {
    // Dashboard state only matters on the dashboard tab; the Log and
    // Accounts tabs manage their own data and loading.
    if (tab !== "dashboard") return;
    setError(false);
    setState(null);
    try {
      setState(await loadDashboardState());
    } catch (e) {
      console.error("dashboard load failed", e);
      setError(true);
    }
  }, [reloadKey, tab]);

  useEffect(() => {
    void load();
  }, [load]);

  // First-launch gate. Re-runs when data reloads so wiping the demo
  // back to an empty real DB brings the welcome screen back.
  const checkOnboarding = useCallback(async () => {
    const repos = createRepositories(getActiveDb());
    const [settings, accounts] = await Promise.all([
      repos.settings.get(),
      repos.accounts.getAll(),
    ]);
    if (shouldShowOnboarding(settings, accounts.length)) {
      setShowOnboarding(true);
    } else {
      setShowOnboarding(false);
      if (accounts.length > 0 && !(settings?.onboardingCompleted ?? false)) {
        // Existing user with data but no flag yet: treat as onboarded.
        await markOnboardingComplete(repos);
      }
    }
    setOnboardingChecked(true);
  }, []);

  useEffect(() => {
    void checkOnboarding();
  }, [checkOnboarding, reloadKey]);

  // One-tap deep links (?add= / ?adjust=). Reads the query string once on
  // launch, resolves it against the REAL database (never demo), then
  // strips it from the URL so a reload can't re-trigger the intent.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let search = "";
      try {
        search = window.location.search;
      } catch {
        return;
      }
      if (!search || search === "?") return;
      try {
        window.history.replaceState(null, "", window.location.pathname + window.location.hash);
      } catch {
        // Non-fatal: the intent string is already captured above.
      }
      let settings;
      let accounts;
      try {
        const repos = createRepositories(getDb());
        [settings, accounts] = await Promise.all([
          repos.settings.get(),
          repos.accounts.getAll(),
        ]);
      } catch {
        if (!cancelled) setDeepLinkError("couldn't read your tracker data — try again");
        return;
      }
      if (cancelled) return;
      if (shouldShowOnboarding(settings, accounts.length)) {
        // No real accounts in THIS browser. On iOS the installed app and
        // Safari keep separate storage, so the data usually lives in the
        // other container — never prefill into demo mode.
        setDeepLinkNotReady(true);
        return;
      }
      const live = accounts.filter((a) => !a.archived);
      const parsed = parseDeepLink(
        search,
        live.map((a) => a.name),
        todayLocal(),
      );
      if (cancelled) return;
      if (!parsed.ok) {
        setDeepLinkError(parsed.error);
        return;
      }
      if (!parsed.intent) return;
      const needle = parsed.intent.accountName.trim().toLowerCase();
      const account = live.find((a) => a.name.trim().toLowerCase() === needle);
      if (!account) {
        // The parser already guaranteed exactly one match; this guards a
        // rename racing the link.
        setDeepLinkError(`account "${parsed.intent.accountName}" not found`);
        return;
      }
      if (isDemoMode()) {
        // Links always target real data — drop out of demo mode first so
        // the sheet can't save into the demo database.
        setDemoMode(false);
        reload();
      }
      if (parsed.intent.kind === "add") {
        setQuickLogPrefill({
          type: parsed.intent.entryType,
          amount: parsed.intent.amountText,
          payee: parsed.intent.payee,
          accountId: account.id,
          date: parsed.intent.date,
        });
      } else {
        setAdjustDialog({ intent: parsed.intent, accountId: account.id });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const consumePrefill = useCallback(() => setQuickLogPrefill(null), []);

  const markInboxApplied = useCallback((id: string) => {
    void (async () => {
      await markInboxEntryApplied(createRepositories(getDb()), id);
      setInboxRefreshKey((k) => k + 1);
    })();
  }, []);

  const handleInboxPrefill = useCallback((prefill: QuickLogPrefill) => {
    setQuickLogPrefill(prefill);
  }, []);

  const handleInboxAdjust = useCallback(
    (intent: AdjustIntent, accountId: string, inboxEntryId: string) => {
      setPendingInboxAdjustId(inboxEntryId);
      setAdjustDialog({ intent, accountId });
    },
    [],
  );

  const onAdjustApplied = useCallback(
    (message: string) => {
      if (pendingInboxAdjustId) {
        markInboxApplied(pendingInboxAdjustId);
        setPendingInboxAdjustId(null);
      }
      setAdjustDialog(null);
      showToast(message);
      reload();
    },
    [reload, showToast, pendingInboxAdjustId, markInboxApplied],
  );

  // Theme + bill notifications, once on mount.
  useEffect(() => {
    const repos = createRepositories(getActiveDb());
    void repos.settings
      .get()
      .then((s) => applyTheme(s?.theme ?? "system"));
    void maybeNotifyUpcomingBills(repos);
    return watchSystemTheme(() => {
      const r2 = createRepositories(getActiveDb());
      void r2.settings.get().then((s) => {
        if ((s?.theme ?? "system") === "system") applyTheme("system");
      });
    });
  }, []);

  const finishOnboarding = useCallback(() => {
    setShowOnboarding(false);
    reload();
  }, [reload]);

  if (!onboardingChecked) {
    return (
      <div className="min-h-dvh bg-stone-100 dark:bg-stone-950">
        {swUpdateAvailable && <SwUpdateBanner />}
        <Loading />
      </div>
    );
  }

  if (showOnboarding) {
    return (
      <div className="min-h-dvh bg-stone-100 dark:bg-stone-950">
        {swUpdateAvailable && <SwUpdateBanner />}
        <div className="mx-auto w-full max-w-md px-4 pt-4">
          <DeepLinkNotices
            error={deepLinkError}
            notReady={deepLinkNotReady}
            onCloseError={() => setDeepLinkError(null)}
            onCloseNotReady={() => setDeepLinkNotReady(false)}
          />
        </div>
        <Onboarding onDone={finishOnboarding} />
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-stone-100 dark:bg-stone-950">
      {swUpdateAvailable && <SwUpdateBanner />}
      <div
        className={`mx-auto flex w-full max-w-md flex-col gap-4 px-4 pb-32 ${
          swUpdateAvailable ? "pt-20" : "pt-4"
        }`}
      >
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
            className="flex h-9 w-9 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-200 dark:text-stone-400 dark:hover:bg-stone-800"
          >
            <GearIcon />
          </button>
        </div>
        <DeepLinkNotices
          error={deepLinkError}
          notReady={deepLinkNotReady}
          onCloseError={() => setDeepLinkError(null)}
          onCloseNotReady={() => setDeepLinkNotReady(false)}
        />
        {tab === "dashboard" && (
          <>
            {isDemoMode() && <DemoBanner onChanged={reload} />}
            <BackupBanner />
            <TransferReviewBanner onChanged={reload} />

            {error ? (
              <LoadError onRetry={reload} />
            ) : state === null ? (
              <Loading />
            ) : !state.hasData ? (
              <EmptyState onLoadDemo={() => void loadDemoData().then(reload)} />
            ) : (
              <>
                <FxWarningBanner currencies={state.fxWarnings} />
                <TodayCards state={state} onPauseGoal={(goalId) => void pauseGoal(goalId)} />
                <PaydayBanner
                  state={state}
                  onStart={openPaydayRun}
                  resolveError={resolveError}
                />
                <TodaysMoves
                  moves={state.moves}
                  baseCurrency={state.baseCurrency}
                  onOpen={(move) => void openMove(move)}
                  onMarkPaid={(move) => void markMovePaid(move)}
                  onSnooze={(move) => void snoozeMove(move)}
                />
                <BalancesList
                  accounts={state.accounts}
                  balances={state.balances}
                  onSelectAccount={() => setTab("accounts")}
                />
                <InboxSection
                  refreshKey={inboxRefreshKey}
                  onPrefill={handleInboxPrefill}
                  onAdjust={handleInboxAdjust}
                  onOpenSettings={() => setSettingsOpen(true)}
                />
                <Upcoming onOpenItem={() => setTab("log")} />
                <Ious onChanged={reload} />
                <p className="pt-2 text-center text-xs text-stone-400">
                  All data stays on this device.
                </p>
              </>
            )}
          </>
        )}

        {tab === "log" && <EverythingLog onChanged={reload} />}

        {tab === "bills" && (
          <RecurringRules
            onChanged={reload}
            onStartPaydayRun={openPaydayRun}
            editRuleId={billsEditRuleId}
            onEditRuleOpened={() => setBillsEditRuleId(null)}
          />
        )}

        {tab === "goals" && <Goals onChanged={reload} />}

        {tab === "accounts" && <Accounts onChanged={reload} />}

        {tab === "insights" && <Insights />}
        {tab === "history" && <History />}
      </div>

      <QuickLog
        onSaved={reload}
        prefill={quickLogPrefill}
        onPrefillConsumed={consumePrefill}
        onInboxEntrySaved={markInboxApplied}
      />

      {adjustDialog && (
        <DeepLinkAdjust
          intent={adjustDialog.intent}
          accountId={adjustDialog.accountId}
          onClose={() => {
            setAdjustDialog(null);
            setPendingInboxAdjustId(null);
          }}
          onApplied={onAdjustApplied}
        />
      )}

      {paydayRun && (
        <PaydayRun
          payDate={paydayRun.payDate}
          paydayRuleId={paydayRun.ruleId}
          occurrenceDate={paydayRun.occurrenceDate}
          onClose={() => setPaydayRun(null)}
          onChanged={reload}
        />
      )}

      {billEditTx && (
        <BillMoveSheet
          tx={billEditTx}
          onClose={() => setBillEditTx(null)}
          onChanged={reload}
        />
      )}

      {iouSplitId && (
        <IouMoveSheet
          splitId={iouSplitId}
          onClose={() => setIouSplitId(null)}
          onChanged={reload}
        />
      )}

      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onChanged={reload}
        storagePersisted={storagePersisted}
      />

      {toast && (
        <div className="fixed bottom-28 left-1/2 z-50 -translate-x-1/2">
          <div className="rounded-full bg-stone-900 px-5 py-2.5 text-sm text-white shadow-lg dark:bg-stone-100 dark:text-stone-900">
            {toast}
          </div>
        </div>
      )}

      <nav
        className="fixed bottom-0 inset-x-0 z-30 border-t border-stone-200 bg-white pb-[env(safe-area-inset-bottom)] dark:border-stone-700 dark:bg-stone-900"
        aria-label="Primary"
      >
        <div className="mx-auto flex w-full max-w-md">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? "page" : undefined}
              className={`relative flex-1 py-3.5 text-sm font-medium transition-colors ${
                tab === t.id
                  ? "text-stone-900 dark:text-stone-100"
                  : "text-stone-400 hover:text-stone-600 dark:hover:text-stone-300"
              }`}
            >
              {t.label}
              {t.id === "dashboard" && (state?.openReviewCount ?? 0) > 0 && (
                <span
                  className="absolute top-2 ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-stone-900 px-1 text-[10px] font-semibold text-white dark:bg-stone-100 dark:text-stone-900"
                  aria-label={`${state?.openReviewCount} items need review`}
                >
                  {state?.openReviewCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </nav>
      {reviewOpen && (
        <ReviewInboxSheet onClose={() => setReviewOpen(false)} onChanged={reload} />
      )}
    </div>
  );
}

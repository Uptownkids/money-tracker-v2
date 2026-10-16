/**
 * Dashboard orchestration: loads everything from Dexie, runs the Phase 2
 * recurring catch-up, and computes the dashboard state with the engine.
 * Components never do money math; they render what this returns.
 */
import { getActiveDb, isDemoMode } from "../data/db.js";
import { createRepositories, type Repositories } from "../data/repositories/index.js";
import { todayLocal, addDays, compareDateOnly, type DateOnly } from "../domain/dates/dateOnly.js";
import { resolvePayCycle, countPaydays, enumeratePaydays } from "../domain/dates/payCycle.js";
import { deriveBalances } from "../domain/engine/balances.js";
import { countedIouTotal } from "../domain/engine/ious.js";
import {
  earmarkedInSpendable,
  fundedThisCycle,
  goalTargetDateOrDefault,
  resolvePinnedContribution,
  committedPerGoal,
  countsTowardCommitment,
} from "../domain/engine/goals.js";
import {
  calculateSafeToSpend,
  computeTodaySpending,
  createDailySnapshot,
  defaultTransactionToBase,
  type CurrencyConverter,
  type SafeToSpendResult,
  type TransactionToBase,
} from "../domain/engine/safeToSpend.js";
import { projectOccurrences } from "../domain/engine/projection.js";
import { generateDueTransactions } from "../domain/engine/recurringEngine.js";
import { rankTodaysMoves, type TodaysMove } from "../domain/engine/todaysMoves.js";
import type { Account } from "../domain/entities/account.js";
import type { DailySnapshot } from "../domain/entities/settings.js";
import type { Goal } from "../domain/entities/goal.js";
import type { MinorUnits } from "../domain/money/money.js";
import { sumMinor, subMinor } from "../domain/money/money.js";
import { convertMinor, FxRateMemory } from "../domain/money/fx.js";

export interface DashboardState {
  today: DateOnly;
  isDemo: boolean;
  hasData: boolean;
  result: SafeToSpendResult;
  snapshot: DailySnapshot;
  todaySpending: MinorUnits;
  /** Snapshot's start-of-day amount minus today's spending (engine math). */
  leftToday: MinorUnits;
  /** normal | amber (left < 20% of daily) | red (overspent) | deficit. */
  heroState: "normal" | "amber" | "red" | "deficit";
  accounts: Account[];
  balances: Record<string, MinorUnits>;
  /** Base-currency total across spendable accounts (cash on hand). */
  cashOnHand: MinorUnits;
  moves: TodaysMove[];
  /** Open "Needs review" inbox items (bank import). Drives the badge. */
  openReviewCount: number;
  nextPayday: DateOnly | null;
  /** True when today is a payday (for the cash card's "Payday today"). */
  isPaydayToday: boolean;
  cycleDaysLeft: number;
  deficitPauseSuggestion: { goalId: string; goalName: string; amount: MinorUnits } | null;
  /** Currencies with no usable FX rate this load (amounts passed through unconverted). */
  fxWarnings: string[];
  /** The user's base currency from settings (fallback "USD"). */
  baseCurrency: string;
}

/** Run catch-up generation for every active rule (idempotent). */
async function runCatchUp(repos: Repositories, today: DateOnly, nowIso: string): Promise<void> {
  const rules = await repos.recurringRules.active();
  const transactions = await repos.transactions.getAll();
  for (const rule of rules) {
    const overrides = await repos.recurringOverrides.byRule(rule.id);
    const gen = generateDueTransactions(rule, overrides, transactions, today, nowIso);
    if (gen.transactions.length > 0) {
      await repos.transactions.putMany(gen.transactions);
    }
    const updated = {
      ...rule,
      lastGeneratedThrough: gen.lastGeneratedThrough,
      remainingOccurrences: gen.remainingOccurrences,
      updatedAt: nowIso,
    };
    await repos.recurringRules.put(updated);
  }
}

/**
 * Currency converter for base-currency totals. Resolution order per the
 * Phase 1 spec: the account's fxRateToBase when set, otherwise the
 * last-used rate for the pair, otherwise a VISIBLE warning is recorded
 * and the amount passes through unconverted (never silently).
 */
export function makeConverter(
  baseCurrency: string,
  fxMemory: FxRateMemory,
  onMissingRate: (currency: string) => void,
): CurrencyConverter {
  const seen = new Set<string>();
  return (amount, currency, account) => {
    if (currency === baseCurrency) return amount;
    const rate =
      account?.fxRateToBase ?? fxMemory.getRate(currency, baseCurrency);
    if (rate) return convertMinor(amount, currency, baseCurrency, rate);
    if (!seen.has(currency)) {
      seen.add(currency);
      onMissingRate(currency);
    }
    return amount;
  };
}

export async function loadDashboardState(): Promise<DashboardState> {
  const db = getActiveDb();
  const repos = createRepositories(db);
  const today = todayLocal();
  const nowIso = new Date().toISOString();

  // No automatic seeding: demo data loads only from an explicit
  // "Load demo" tap (DemoBanner) or onboarding, never on app load.
  const isDemo = isDemoMode();

  // Phase 2 catch-up on every app start.
  await runCatchUp(repos, today, nowIso);

  const [accounts, transactions, rules, overrides, goals, splits, settings] = await Promise.all([
    repos.accounts.getAll(),
    repos.transactions.getAll(),
    repos.recurringRules.getAll(),
    repos.recurringOverrides.getAll(),
    repos.goals.getAll(),
    repos.splits.getAll(),
    repos.settings.get(),
  ]);

  const hasData = accounts.length > 0;
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const fxMemory = new FxRateMemory();
  for (const [pair, rate] of Object.entries(settings?.lastUsedFxRates ?? {})) {
    const [from, to] = pair.split("->");
    if (from && to) fxMemory.setRate(from, to, rate);
  }
  const fxWarnings: string[] = [];
  const convertToBase = makeConverter(baseCurrency, fxMemory, (c) =>
    fxWarnings.push(c),
  );
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const accountCurrencyOf = (id: string): string =>
    accountsById.get(id)?.currency ?? baseCurrency;
  // One transaction's contribution to a base-currency total. fx.baseAmount
  // is denominated in the ACCOUNT's currency (see money/fx.ts), so it
  // converts with the account's currency, never t.currency.
  const txToBase: TransactionToBase = defaultTransactionToBase(
    accountCurrencyOf,
    convertToBase,
  );

  const balances = deriveBalances(accounts, transactions);

  const activeRules = rules.filter((r) => r.active);
  const primaryRule = activeRules.find((r) => r.isPrimaryPayday) ?? null;
  const cycle = primaryRule ? resolvePayCycle(today, primaryRule) : null;
  const nextPayday = cycle ? cycle.nextPayday : null;
  const windowEnd = nextPayday ?? addDays(today, 30);
  const cycleStart: DateOnly = cycle ? cycle.cycleStart : today;
  const cycleEnd: DateOnly = cycle ? cycle.cycleEnd : addDays(today, 29);

  // Committed bills: projected Bill/Subscription occurrences due between
  // today and the next payday, merged with Scheduled rows. Overdue bills
  // count via their Scheduled rows (catch-up guarantees those exist).
  // Occurrences that already have a settled (Cleared/Pending) transaction
  // are excluded from the projection: marking a Scheduled bill paid must
  // not leave it counted in committed after it has left available.
  const settledOccurrenceKeys = new Set(
    transactions
      .filter((t) => t.recurringRuleId && t.occurrenceDate && t.status !== "Scheduled")
      .map((t) => `${t.recurringRuleId}:${t.occurrenceDate}`),
  );
  const projected = projectOccurrences(activeRules, overrides, today, windowEnd)
    .filter((p) => p.kind !== "Income")
    .filter((p) => !settledOccurrenceKeys.has(`${p.ruleId}:${p.occurrenceDate}`));
  // Debt-payment rules (card and loan alike) stay in committed: only the
  // minimum due is set aside, and no balance is subtracted from
  // available, so there is nothing to double-count.
  const scheduledBills = transactions.filter(
    (t) => t.status === "Scheduled" && t.type !== "Income",
  );

  // Goal commitments, pinning each cycle's contribution on first use.
  // Completed goals are done: no contributions, no commitments.
  const activeGoals = goals.filter((g) => countsTowardCommitment(g));
  const goalValues: MinorUnits[] = [];
  const goalContributions = new Map<string, MinorUnits>();
  for (const goal of activeGoals) {
    const earmarked = earmarkedInSpendable(goal.id, transactions, accountsById, txToBase);
    const funded = fundedThisCycle(goal.id, transactions, cycleStart, cycleEnd, accountsById, txToBase, goal.linkedSavingsAccountId);
    const cyclesRemaining = primaryRule
      ? countPaydays(cycleStart, goalTargetDateOrDefault(goal, cycleStart), primaryRule)
      : 0;
    const { amount, shouldPin } = resolvePinnedContribution(goal, cycleStart, transactions, cyclesRemaining);
    if (shouldPin) {
      const pinned: Goal = {
        ...goal,
        pinnedContribution: { cycleStart, amount },
        updatedAt: nowIso,
      };
      await repos.goals.put(pinned);
    }
    const committed = committedPerGoal(earmarked, amount, funded);
    goalValues.push(committed);
    goalContributions.set(goal.id, amount);
  }

  const todaySpending = computeTodaySpending(transactions, today, txToBase);

  const countedIous = countedIouTotal(splits, windowEnd, baseCurrency);

  const result = calculateSafeToSpend({
    today,
    accounts,
    balances,
    projectedBills: projected,
    scheduledBills,
    goalContributions: sumMinor(goalValues),
    countedIous,
    buffer: settings?.bufferAmount ?? 0,
    todaySpending,
    nextPayday,
    baseCurrency,
    convertToBase,
    accountCurrencyOf,
  });

  let snapshot = await repos.dailySnapshots.byDate(today);
  if (!snapshot) {
    snapshot = createDailySnapshot(today, result, nowIso);
    await repos.dailySnapshots.put(snapshot);
  }

  // Hero display values, all from the engine: the day's number is pinned
  // in the snapshot; "left today" moves as spending is logged.
  const leftToday = subMinor(snapshot.startOfDayAmount, todaySpending);
  const heroState =
    result.mode === "deficit"
      ? "deficit"
      : leftToday < 0
        ? "red"
        : leftToday * 5 < snapshot.startOfDayAmount
          ? "amber"
          : "normal";

  const isPaydayToday = primaryRule
    ? enumeratePaydays(primaryRule, today, today).length > 0
    : false;
  const todaysRun = (await repos.paydayRuns.byPayDate(today)).find((r) => r.completed);
  // Today's Moves snoozes: hide a move while snoozedUntil >= today, and
  // garbage-collect expired rows so the store stays small.
  const snoozedRows = await repos.snoozedMoves.getAll();
  const expired = snoozedRows.filter(
    (s) => compareDateOnly(s.snoozedUntil, today) < 0,
  );
  if (expired.length > 0) {
    await Promise.all(expired.map((s) => repos.snoozedMoves.remove(s.moveId)));
  }
  const snoozed = new Map(
    snoozedRows
      .filter((s) => compareDateOnly(s.snoozedUntil, today) >= 0)
      .map((s) => [s.moveId, s.snoozedUntil] as const),
  );
  const openReviewCount = await repos.reviewItems.openCount();
  const moves = rankTodaysMoves({
    today,
    isPaydayToday,
    paydayRunCompleted: !!todaysRun,
    scheduledBills: transactions.filter((t) => t.status === "Scheduled"),
    projectedBills: projectOccurrences(activeRules, overrides, today, addDays(today, 60)),
    rules: activeRules,
    pendingTransactions: transactions.filter((t) => t.status === "Pending"),
    splits,
    goals,
    snoozed,
    // Moves key bill candidates as `p:<ruleId>:<occurrenceDate>`; the
    // dashboard's settled set is unprefixed, so adapt it here.
    settledOccurrenceKeys: new Set([...settledOccurrenceKeys].map((k) => `p:${k}`)),
    openReviewCount,
  });

  let deficitPauseSuggestion: DashboardState["deficitPauseSuggestion"] = null;
  if (result.mode === "deficit") {
    const ordered = [...activeGoals].sort((a, b) => a.priority - b.priority);
    const first = ordered[0];
    if (first) {
      deficitPauseSuggestion = {
        goalId: first.id,
        goalName: first.name,
        amount: goalContributions.get(first.id) ?? 0,
      };
    }
  }

  return {
    today,
    isDemo,
    hasData,
    result,
    snapshot,
    todaySpending,
    leftToday,
    heroState,
    accounts: accounts.filter((a) => !a.archived),
    balances,
    cashOnHand: accounts
      .filter((a) => !a.archived && a.countsAsSpendable)
      .reduce(
        (sum, a) => sum + convertToBase(balances[a.id] ?? 0, a.currency, a),
        0,
      ),
    moves,
    openReviewCount,
    nextPayday,
    isPaydayToday,
    cycleDaysLeft: cycle ? cycle.daysLeft : 30,
    deficitPauseSuggestion,
    fxWarnings,
    baseCurrency,
  };
}

/**
 * Recalculate and overwrite today's DailySnapshot. The application's
 * signal after confirmPaydayIncome or completePaydayRun (Phase 5 Payday
 * Run screen): the pay cycle and available funds have materially changed,
 * so the pinned morning number must be refreshed.
 */
export async function refreshTodaySnapshot(): Promise<DailySnapshot> {
  const state = await loadDashboardState();
  const repos = createRepositories(getActiveDb());
  const snapshot = createDailySnapshot(
    state.today,
    state.result,
    new Date().toISOString(),
  );
  await repos.dailySnapshots.put(snapshot);
  return snapshot;
}

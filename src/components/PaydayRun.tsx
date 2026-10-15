/**
 * Payday Run: a guided 5-step checklist for payday.
 *
 * 1. Confirm the paycheck (updates the generated Scheduled income row in
 *    place via confirmPaydayIncome — never creates a second row).
 * 2. Review the bills due this pay cycle and mark them set aside.
 * 3. Fund this cycle's goal contributions (Transfers carrying goalId;
 *    skippable).
 * 4. Record credit-card payments (Transfers, never expenses; skippable).
 * 5. See the recomputed daily safe-to-spend number and complete the run.
 *
 * Progress is stored in PaydayRunState after every step change, so the
 * run is resumable. Confirming the paycheck and completing the run each
 * trigger refreshTodaySnapshot(). A completed run for the pay date shows
 * a summary instead of the checklist.
 */
import { useEffect, useMemo, useState } from "react";
import { createRepositories, type Repositories } from "../data/repositories/index.js";
import { getActiveDb } from "../data/db.js";
import {
  completePaydayRun,
  confirmPaydayIncome,
  createPaydayRunState,
  nextIncompleteStep,
  settleCardPayment,
} from "../domain/engine/paydayRun.js";
import { loadDashboardState, refreshTodaySnapshot } from "../app/dashboard.js";
import { parseDollarsToMinor } from "../app/quickLog.js";
import { formatMoney } from "../app/format.js";
import { addDays, todayLocal, type DateOnly } from "../domain/dates/dateOnly.js";
import { countPaydays, enumeratePaydays } from "../domain/dates/payCycle.js";
import { isCardPaymentRule, projectOccurrences } from "../domain/engine/projection.js";
import {
  fundedThisCycle,
  goalTargetDateOrDefault,
  resolvePinnedContribution,
} from "../domain/engine/goals.js";
import { deriveBalances } from "../domain/engine/balances.js";
import { maxZero, subMinor, sumMinor, type MinorUnits } from "../domain/money/money.js";
import { decimalsOf } from "../domain/money/currency.js";
import type { Account } from "../domain/entities/account.js";
import type { Goal } from "../domain/entities/goal.js";
import type { RecurringRule, RecurringOverride } from "../domain/entities/recurringRule.js";
import type { Transaction } from "../domain/entities/transaction.js";
import { countsAsIncome } from "../domain/entities/transaction.js";
import type { PaydayRunState } from "../domain/entities/settings.js";

export interface PaydayRunProps {
  payDate: DateOnly;
  paydayRuleId: string;
  occurrenceDate: DateOnly;
  onClose: () => void;
  onChanged: () => void;
}

type StepNum = 1 | 2 | 3 | 4 | 5;

const STEP_LABELS: Record<StepNum, string> = {
  1: "Paycheck",
  2: "Bills",
  3: "Goals",
  4: "Cards",
  5: "Daily number",
};

interface BillRow {
  key: string;
  name: string;
  date: DateOnly;
  amount: MinorUnits;
  currency: string;
}

interface GoalRow {
  goal: Goal;
  contribution: MinorUnits;
  funded: MinorUnits;
  remainder: MinorUnits;
}

interface LoadedData {
  rules: RecurringRule[];
  overrides: RecurringOverride[];
  rule: RecurringRule | null;
  accounts: Account[];
  transactions: Transaction[];
  goals: Goal[];
  baseCurrency: string;
  expectedAmount: MinorUnits;
  expectedCurrency: string;
  cycleStart: DateOnly;
  cycleEnd: DateOnly;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const prettyDate = (d: DateOnly): string =>
  `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}`;

/** Display a minor-unit integer as a dollars string (no money math, formatting only). */
const minorToInput = (minor: MinorUnits, currency: string): string => {
  const d = decimalsOf(currency);
  return (minor / 10 ** d).toFixed(d);
};

const fieldCls =
  "w-full rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-3.5 py-2.5 text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 focus:border-stone-400 dark:focus:border-stone-500 focus:outline-none";
const labelCls = "mb-1.5 block text-xs font-medium text-stone-500 dark:text-stone-400";
const primaryBtn =
  "rounded-full bg-stone-900 dark:bg-stone-100 py-3 text-sm font-medium text-white dark:text-stone-900 transition-colors hover:bg-stone-700 dark:hover:bg-stone-200 disabled:opacity-60";
const secondaryBtn =
  "rounded-full border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 py-2.5 text-sm font-medium text-stone-700 dark:text-stone-300 transition-colors hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-60";

export function PaydayRun({ payDate, paydayRuleId, occurrenceDate, onClose, onChanged }: PaydayRunProps) {
  const [run, setRun] = useState<PaydayRunState | null>(null);
  const [data, setData] = useState<LoadedData | null>(null);
  const [step, setStep] = useState<StepNum>(1);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Step 1
  const [amountInput, setAmountInput] = useState("");
  const [payStatus, setPayStatus] = useState<"Cleared" | "Pending">("Cleared");
  const [stepError, setStepError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  // Step 2: checkboxes are a review aid; the button completes the step.
  const [checkedBills, setCheckedBills] = useState<Set<string>>(new Set());

  // Step 3: per-goal source account.
  const [goalSources, setGoalSources] = useState<Record<string, string>>({});

  // Step 4
  const [cardSourceId, setCardSourceId] = useState("");
  const [cardAmounts, setCardAmounts] = useState<Record<string, string>>({});

  // Step 5
  const [newDaily, setNewDaily] = useState<MinorUnits | null>(null);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persistRun = async (repos: Repositories, next: PaydayRunState): Promise<void> => {
    const stamped: PaydayRunState = { ...next, updatedAt: new Date().toISOString() };
    await repos.paydayRuns.put(stamped);
    setRun(stamped);
  };

  const load = async () => {
    try {
      const repos = createRepositories(getActiveDb());
      const [rules, accounts, transactions, goals, overrides, settings] = await Promise.all([
        repos.recurringRules.getAll(),
        repos.accounts.getAll(),
        repos.transactions.getAll(),
        repos.goals.getAll(),
        repos.recurringOverrides.getAll(),
        repos.settings.get(),
      ]);
      const baseCurrency = settings?.baseCurrency ?? "USD";
      const rule =
        rules.find((r) => r.id === paydayRuleId) ??
        rules.find((r) => r.isPrimaryPayday) ??
        null;

      // Expected paycheck: the generated Scheduled income row wins; the
      // rule amount is the fallback.
      const generated = transactions.find(
        (t) =>
          t.recurringRuleId === paydayRuleId &&
          t.occurrenceDate === occurrenceDate &&
          countsAsIncome(t) &&
          t.status === "Scheduled",
      );
      const expectedAmount = generated?.amount ?? rule?.amount ?? 0;
      const expectedCurrency = generated?.currency ?? rule?.currency ?? baseCurrency;

      // Pay-cycle window this payday opens.
      const cycleStart: DateOnly = occurrenceDate;
      let cycleEnd: DateOnly = addDays(occurrenceDate, 29);
      if (rule) {
        const next = enumeratePaydays(rule, addDays(occurrenceDate, 1), addDays(occurrenceDate, 400))[0];
        if (next) cycleEnd = addDays(next, -1);
      }

      // Pin this cycle's goal contributions (same as the dashboard).
      const activeGoals = goals.filter((g) => !g.paused);
      const pinnedGoals: Goal[] = [];
      const nowIso = new Date().toISOString();
      for (const goal of activeGoals) {
        const cyclesRemaining = rule
          ? countPaydays(cycleStart, goalTargetDateOrDefault(goal, cycleStart), rule)
          : 0;
        const { shouldPin, amount } = resolvePinnedContribution(
          goal,
          cycleStart,
          transactions,
          cyclesRemaining,
        );
        if (shouldPin) {
          const pinned: Goal = {
            ...goal,
            pinnedContribution: { cycleStart, amount },
            updatedAt: nowIso,
          };
          await repos.goals.put(pinned);
          pinnedGoals.push(pinned);
        } else {
          pinnedGoals.push(goal);
        }
      }

      // Restore or create the run. Persist immediately so leaving and
      // coming back resumes from the stored state.
      const existing = await repos.paydayRuns.byPayDate(payDate);
      let nextRun =
        existing.find((r) => !r.completed) ?? existing.find((r) => r.completed) ?? null;
      if (!nextRun) {
        nextRun = createPaydayRunState(payDate, expectedAmount, nowIso);
        await repos.paydayRuns.put(nextRun);
      }
      setRun(nextRun);
      setData({
        rule,
        rules,
        overrides,
        accounts,
        transactions,
        goals: pinnedGoals,
        baseCurrency,
        expectedAmount,
        expectedCurrency,
        cycleStart,
        cycleEnd,
      });
      setAmountInput(minorToInput(nextRun.confirmedAmount ?? expectedAmount, expectedCurrency));
      if (!nextRun.completed) setStep(nextIncompleteStep(nextRun));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load the payday run.");
    }
  };

  const reloadTransactions = async (): Promise<Transaction[]> => {
    const repos = createRepositories(getActiveDb());
    const txs = await repos.transactions.getAll();
    setData((d) => (d ? { ...d, transactions: txs } : d));
    return txs;
  };

  // ---- Derived ----------------------------------------------------------

  const accountsById = useMemo(
    () => new Map((data?.accounts ?? []).map((a) => [a.id, a])),
    [data?.accounts],
  );

  const spendableAccounts = useMemo(
    () => (data?.accounts ?? []).filter((a) => !a.archived && a.countsAsSpendable),
    [data],
  );

  const billRows: BillRow[] = useMemo(() => {
    if (!data) return [];
    return buildBillRows(data);
  }, [data]);

  const goalRows: GoalRow[] = useMemo(() => {
    if (!data) return [];
    const { rule, goals, transactions, cycleStart, cycleEnd } = data;
    return goals.map((goal) => {
      const cyclesRemaining = rule
        ? countPaydays(cycleStart, goalTargetDateOrDefault(goal, cycleStart), rule)
        : 0;
      const { amount: contribution } = resolvePinnedContribution(
        goal,
        cycleStart,
        transactions,
        cyclesRemaining,
      );
      const funded = fundedThisCycle(goal.id, transactions, cycleStart, cycleEnd, accountsById);
      return { goal, contribution, funded, remainder: maxZero(subMinor(contribution, funded)) };
    });
  }, [data, accountsById]);

  const cardRows = useMemo(() => {
    if (!data) return [];
    const balances = deriveBalances(data.accounts, data.transactions);
    return data.accounts
      .filter((a) => !a.archived && a.type === "CreditCard")
      .map((a) => {
        const balance = balances[a.id] ?? 0;
        return { account: a, owed: balance < 0 ? -balance : 0 };
      })
      .filter((c) => c.owed > 0);
  }, [data]);

  const billsTotal = useMemo(() => sumMinor(billRows.map((b) => b.amount)), [billRows]);

  // ---- Step 1: confirm paycheck ------------------------------------------

  const confirmPaycheck = async () => {
    if (!run || !data || working) return;
    setStepError(null);
    const minor = parseDollarsToMinor(amountInput, data.expectedCurrency);
    if (minor === null) {
      setStepError(`Enter an amount like 12.34.`);
      return;
    }
    setWorking(true);
    try {
      const repos = createRepositories(getActiveDb());
      const txs = await repos.transactions.getAll();
      const nowIso = new Date().toISOString();
      const { transactions: next, confirmed } = confirmPaydayIncome(
        txs,
        paydayRuleId,
        occurrenceDate,
        minor,
        payStatus,
        nowIso,
      );
      if (!confirmed) {
        setStepError(
          "Could not find the scheduled paycheck for this date. It may already be confirmed.",
        );
        setWorking(false);
        return;
      }
      await repos.transactions.putMany(next);
      await persistRun(repos, { ...run, confirmedAmount: minor });
      setData((d) => (d ? { ...d, transactions: next } : d));
      // The pay cycle and available funds changed: recalculate and
      // overwrite today's snapshot.
      await refreshTodaySnapshot();
      setStep(2);
    } catch (e) {
      setStepError(e instanceof Error ? e.message : "Could not confirm the paycheck.");
    } finally {
      setWorking(false);
    }
  };

  // ---- Step 2: bills set aside --------------------------------------------

  const toggleBill = (key: string) => {
    setCheckedBills((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const completeBillsStep = async () => {
    if (!run || working) return;
    setWorking(true);
    try {
      const repos = createRepositories(getActiveDb());
      await persistRun(repos, {
        ...run,
        steps: { ...run.steps, billsSetAside: true },
      });
      setStep(3);
    } finally {
      setWorking(false);
    }
  };

  // ---- Step 3: fund goals ---------------------------------------------------

  const defaultSourceFor = (goal: Goal): string => {
    const match = spendableAccounts.find((a) => a.currency === goal.currency);
    return (match ?? spendableAccounts[0])?.id ?? "";
  };

  const fundGoal = async (row: GoalRow) => {
    if (!run || !data || working) return;
    setStepError(null);
    const sourceId = goalSources[row.goal.id] ?? defaultSourceFor(row.goal);
    const source = accountsById.get(sourceId);
    if (!source) {
      setStepError(`Pick a source account to fund ${row.goal.name}.`);
      return;
    }
    if (source.currency !== row.goal.currency) {
      setStepError(
        `${source.name} is in ${source.currency} but ${row.goal.name} is in ${row.goal.currency}. Pick a matching account.`,
      );
      return;
    }
    if (row.remainder <= 0) return;
    setWorking(true);
    try {
      const nowIso = new Date().toISOString();
      const today = todayLocal();
      const transfer: Transaction = {
        id: crypto.randomUUID(),
        type: "Transfer",
        amount: row.remainder,
        currency: source.currency,
        date: today,
        accountId: source.id,
        categoryId: null,
        payee: `Goal funding: ${row.goal.name}`,
        status: "Cleared",
        notes: "Payday run",
        tags: [],
        // Linked savings account when set; otherwise a self-transfer in
        // the spendable account (balance-neutral allocation record).
        transferToAccountId: row.goal.linkedSavingsAccountId ?? source.id,
        goalId: row.goal.id,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      const repos = createRepositories(getActiveDb());
      await repos.transactions.put(transfer);
      await reloadTransactions();
      await persistRun(repos, {
        ...run,
        steps: {
          ...run.steps,
          goalContributions: { ...run.steps.goalContributions, [row.goal.id]: true },
        },
      });
    } catch (e) {
      setStepError(e instanceof Error ? e.message : "Could not fund the goal.");
    } finally {
      setWorking(false);
    }
  };

  const continueFromGoals = async () => {
    if (!run || working) return;
    setWorking(true);
    try {
      const repos = createRepositories(getActiveDb());
      await persistRun(repos, {
        ...run,
        steps: { ...run.steps, goalsStepDone: true },
      });
      setStep(4);
    } finally {
      setWorking(false);
    }
  };

  // ---- Step 4: pay down cards -----------------------------------------------

  const recordCardPayment = async (cardId: string, owed: MinorUnits, cardCurrency: string) => {
    if (!run || !data || working) return;
    setStepError(null);
    const source = accountsById.get(cardSourceId);
    if (!source) {
      setStepError("Pick the account the payment comes from.");
      return;
    }
    if (source.id === cardId) {
      setStepError("Pick a different account from the card being paid.");
      return;
    }
    const raw = cardAmounts[cardId] ?? "";
    const minor = parseDollarsToMinor(raw, source.currency);
    if (minor === null) {
      setStepError("Enter a payment amount like 120.00.");
      return;
    }
    if (source.currency === cardCurrency && minor > owed) {
      setStepError("That is more than the balance owed on this card.");
      return;
    }
    setWorking(true);
    try {
      const nowIso = new Date().toISOString();
      const card = accountsById.get(cardId);
      // Settle an open Scheduled row for this card this cycle in place
      // when one exists (entered amount, today's date, -> Cleared); only
      // create a new Transfer when there is none. Debt payments are
      // Transfers, never Expenses, so no second Transfer is ever created.
      const settlement = settleCardPayment(data.transactions, data.rules, {
        cardId,
        sourceAccountId: source.id,
        sourceCurrency: source.currency,
        cardName: card?.name ?? "credit card",
        amount: minor,
        today: todayLocal(),
        cycleStart: data.cycleStart,
        cycleEnd: data.cycleEnd,
        nowIso,
      });
      const repos = createRepositories(getActiveDb());
      const changed = settlement.transactions.find((t) => t.id === settlement.transactionId);
      if (!changed) throw new Error("Could not record the payment.");
      await repos.transactions.put(changed);
      await reloadTransactions();
      await persistRun(repos, {
        ...run,
        steps: { ...run.steps, cardPaymentDone: true },
      });
      setStep(5);
    } catch (e) {
      setStepError(e instanceof Error ? e.message : "Could not record the payment.");
    } finally {
      setWorking(false);
    }
  };

  const skipCards = async () => {
    if (!run || working) return;
    setWorking(true);
    try {
      const repos = createRepositories(getActiveDb());
      await persistRun(repos, {
        ...run,
        steps: { ...run.steps, cardPaymentDone: true },
      });
      setStep(5);
    } finally {
      setWorking(false);
    }
  };

  // ---- Step 5: new daily number ----------------------------------------------

  useEffect(() => {
    if (step !== 5 || !run || run.completed) return;
    let cancelled = false;
    void (async () => {
      try {
        const state = await loadDashboardState();
        if (!cancelled) setNewDaily(state.snapshot.startOfDayAmount);
      } catch {
        if (!cancelled) setNewDaily(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const completeRun = async () => {
    if (!run || !data || working) return;
    setWorking(true);
    try {
      const repos = createRepositories(getActiveDb());
      const done = completePaydayRun(run, new Date().toISOString());
      await repos.paydayRuns.put(done);
      setRun(done);
      await refreshTodaySnapshot();
      onChanged();
      onClose();
    } finally {
      setWorking(false);
    }
  };

  // ---- Render -----------------------------------------------------------------

  const stepDone = (n: StepNum): boolean =>
    !!run && (n < nextIncompleteStep(run) || run.completed);

  const goToStep = (n: StepNum) => {
    if (!run || run.completed) return;
    if (n <= nextIncompleteStep(run)) setStep(n);
  };

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Payday run">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div className="absolute inset-0 mx-auto flex w-full max-w-lg flex-col bg-white dark:bg-stone-900 sm:inset-y-6 sm:rounded-3xl sm:shadow-2xl">
        <div className="flex items-start justify-between p-5 pb-3">
          <div>
            <h2 className="font-display text-xl text-stone-900 dark:text-stone-100">Payday run</h2>
            <p className="mt-0.5 text-sm text-stone-500 dark:text-stone-400">{prettyDate(payDate)}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close payday run"
            className="flex h-8 w-8 items-center justify-center rounded-full text-lg text-stone-500 dark:text-stone-400 transition-colors hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            ×
          </button>
        </div>

        {loadError ? (
          <div className="flex flex-1 items-center justify-center p-8">
            <p className="text-sm text-red-700 dark:text-red-300">{loadError}</p>
          </div>
        ) : !run || !data ? (
          <div className="flex flex-1 items-center justify-center p-8">
            <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>
          </div>
        ) : run.completed ? (
          <RunSummary run={run} data={data} onClose={onClose} />
        ) : (
          <>
            <ol className="flex gap-1 px-5 pb-4" aria-label="Payday run steps">
              {([1, 2, 3, 4, 5] as StepNum[]).map((n) => {
                const done = stepDone(n);
                const current = step === n;
                return (
                  <li key={n} className="flex-1">
                    <button
                      type="button"
                      onClick={() => goToStep(n)}
                      disabled={!done && !current}
                      className={`flex w-full flex-col items-center gap-1 rounded-xl px-1 py-2 text-[11px] font-medium transition-colors ${
                        current
                          ? "bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900"
                          : done
                            ? "text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800"
                            : "text-stone-400"
                      }`}
                    >
                      <span
                        className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${
                          done
                            ? "bg-emerald-600 dark:bg-emerald-500 text-white"
                            : current
                              ? "bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100"
                              : "bg-stone-200 dark:bg-stone-700 text-stone-500 dark:text-stone-400"
                        }`}
                      >
                        {done ? "✓" : n}
                      </span>
                      {STEP_LABELS[n]}
                    </button>
                  </li>
                );
              })}
            </ol>

            <div className="flex-1 overflow-y-auto px-5 pb-8">
              {step === 1 && (
                <StepConfirmPaycheck
                  run={run}
                  data={data}
                  amountInput={amountInput}
                  setAmountInput={setAmountInput}
                  payStatus={payStatus}
                  setPayStatus={setPayStatus}
                  error={stepError}
                  working={working}
                  onConfirm={() => void confirmPaycheck()}
                />
              )}
              {step === 2 && (
                <StepBills
                  bills={billRows}
                  total={billsTotal}
                  checked={checkedBills}
                  onToggle={toggleBill}
                  working={working}
                  onDone={() => void completeBillsStep()}
                />
              )}
              {step === 3 && (
                <StepGoals
                  rows={goalRows}
                  run={run}
                  spendable={spendableAccounts}
                  sources={goalSources}
                  onSource={(goalId, accountId) =>
                    setGoalSources((s) => ({ ...s, [goalId]: accountId }))
                  }
                  defaultSourceFor={defaultSourceFor}
                  error={stepError}
                  working={working}
                  onFund={(row) => void fundGoal(row)}
                  onContinue={() => void continueFromGoals()}
                />
              )}
              {step === 4 && (
                <StepCards
                  cards={cardRows}
                  spendable={spendableAccounts}
                  sourceId={cardSourceId}
                  setSourceId={setCardSourceId}
                  amounts={cardAmounts}
                  setAmount={(id, v) => setCardAmounts((s) => ({ ...s, [id]: v }))}
                  error={stepError}
                  working={working}
                  onPay={(id, owed, cur) => void recordCardPayment(id, owed, cur)}
                  onSkip={() => void skipCards()}
                />
              )}
              {step === 5 && (
                <StepDailyNumber
                  daily={newDaily}
                  currency={data.baseCurrency}
                  working={working}
                  onComplete={() => void completeRun()}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The checklist bill list: projected Bill/Subscription occurrences due
 * between cycleStart and cycleEnd, merged with existing Scheduled rows.
 * Dedupe is on (recurringRuleId, occurrenceDate) with the Scheduled row
 * winning (it may carry an edited amount); debt-payment projections and
 * occurrences that already have a settled (Cleared/Pending) transaction
 * are excluded — the same semantics as mergeCommittedBills in
 * domain/engine/safeToSpend.ts, but keeping name and date for display.
 */
function buildBillRows(data: LoadedData): BillRow[] {
  const { rules, overrides, transactions, cycleStart, cycleEnd } = data;
  const activeRules = rules.filter((r) => r.active);
  const rulesById = new Map(activeRules.map((r) => [r.id, r]));
  const accountsById = new Map(data.accounts.map((a) => [a.id, a]));

  const settledOccurrenceKeys = new Set(
    transactions
      .filter((t) => t.recurringRuleId && t.occurrenceDate && t.status !== "Scheduled")
      .map((t) => `${t.recurringRuleId}:${t.occurrenceDate}`),
  );
  // Only CARD payments are excluded here (the dedicated card step handles
  // them). Loan payments stay in the bills list — loan balances are not
  // subtracted from available, so the minimum must be set aside.
  const cardPaymentRuleIds = new Set(
    activeRules
      .filter((r) => isCardPaymentRule(r, (id) => accountsById.get(id)?.type))
      .map((r) => r.id),
  );
  const scheduledBills = transactions.filter(
    (t) =>
      t.status === "Scheduled" &&
      t.type !== "Income" &&
      !(t.recurringRuleId && cardPaymentRuleIds.has(t.recurringRuleId)),
  );

  const byKey = new Map<string, BillRow>();
  for (const p of projectOccurrences(activeRules, overrides, cycleStart, cycleEnd, (id) => accountsById.get(id)?.type)) {
    if (p.kind === "Income" || p.isCardPayment) continue;
    if (settledOccurrenceKeys.has(`${p.ruleId}:${p.occurrenceDate}`)) continue;
    byKey.set(`${p.ruleId}:${p.occurrenceDate}`, {
      key: `${p.ruleId}:${p.occurrenceDate}`,
      name: rulesById.get(p.ruleId)?.name ?? "Bill",
      date: p.date,
      amount: p.amount,
      currency: p.currency,
    });
  }
  for (const t of scheduledBills) {
    const key =
      t.recurringRuleId && t.occurrenceDate
        ? `${t.recurringRuleId}:${t.occurrenceDate}`
        : `tx:${t.id}`;
    const amount = t.fx ? t.fx.baseAmount : t.amount;
    const currency = t.fx
      ? accountsById.get(t.accountId)?.currency || t.currency
      : t.currency;
    byKey.set(key, {
      key,
      name: t.payee,
      date: t.date,
      amount,
      currency,
    });
  }
  return [...byKey.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function RunSummary({ run, data, onClose }: { run: PaydayRunState; data: LoadedData; onClose: () => void }) {
  const steps: { label: string; done: boolean }[] = [
    {
      label: `Paycheck confirmed${run.confirmedAmount !== undefined ? ` · ${formatMoney(run.confirmedAmount, data.expectedCurrency)}` : ""}`,
      done: run.confirmedAmount !== undefined,
    },
    { label: "Bills set aside", done: run.steps.billsSetAside },
    {
      label: "Goals funded",
      done:
        run.steps.goalsStepDone &&
        Object.keys(run.steps.goalContributions).length > 0,
    },
    { label: "Cards addressed", done: run.steps.cardPaymentDone },
  ];
  return (
    <div className="flex flex-1 flex-col items-center px-6 pb-8 pt-4 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900 text-xl text-emerald-700 dark:text-emerald-300">
        ✓
      </div>
      <h3 className="font-display mt-4 text-lg text-stone-900 dark:text-stone-100">Run completed</h3>
      <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
        Payday {prettyDate(run.payDate)} · expected {formatMoney(run.expectedAmount, data.expectedCurrency)}
      </p>
      <ul className="mt-6 w-full space-y-2 text-left">
        {steps.map((s) => (
          <li
            key={s.label}
            className="flex items-center gap-3 rounded-2xl border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800 px-4 py-3"
          >
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${
                s.done ? "bg-emerald-600 dark:bg-emerald-500 text-white" : "bg-stone-200 dark:bg-stone-700 text-stone-500 dark:text-stone-400"
              }`}
            >
              {s.done ? "✓" : "–"}
            </span>
            <span className="text-sm text-stone-800 dark:text-stone-200">{s.label}</span>
          </li>
        ))}
      </ul>
      <button type="button" onClick={onClose} className={`${primaryBtn} mt-8 w-full`}>
        Done
      </button>
    </div>
  );
}

function StepConfirmPaycheck(props: {
  run: PaydayRunState;
  data: LoadedData;
  amountInput: string;
  setAmountInput: (v: string) => void;
  payStatus: "Cleared" | "Pending";
  setPayStatus: (s: "Cleared" | "Pending") => void;
  error: string | null;
  working: boolean;
  onConfirm: () => void;
}) {
  const { data, amountInput, setAmountInput, payStatus, setPayStatus, error, working, onConfirm } = props;
  const already = props.run.confirmedAmount !== undefined;
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800 p-4">
        <p className={labelCls}>Expected paycheck</p>
        <p className="font-display text-3xl text-stone-900 dark:text-stone-100">
          {formatMoney(data.expectedAmount, data.expectedCurrency)}
        </p>
        {data.rule && (
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            {data.rule.name} · {prettyDate(props.run.payDate)}
          </p>
        )}
      </div>

      {already ? (
        <div className="rounded-2xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950 p-4">
          <p className="text-sm font-medium text-emerald-800 dark:text-emerald-200">
            Confirmed at {formatMoney(props.run.confirmedAmount!, data.expectedCurrency)}
          </p>
          <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">
            The scheduled paycheck row was updated in place.
          </p>
        </div>
      ) : (
        <>
          <div>
            <label htmlFor="pr-amount" className={labelCls}>
              Actual amount received
            </label>
            <input
              id="pr-amount"
              type="text"
              inputMode="decimal"
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              className={`${fieldCls} font-display text-2xl`}
            />
          </div>
          <div>
            <span className={labelCls}>Status</span>
            <div className="flex rounded-full bg-stone-100 dark:bg-stone-800 p-1" role="group" aria-label="Paycheck status">
              {(["Cleared", "Pending"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setPayStatus(s)}
                  className={`flex-1 rounded-full py-2 text-sm font-medium transition-colors ${
                    payStatus === s
                      ? "bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-sm"
                      : "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          {error && <p className="text-sm font-medium text-red-700 dark:text-red-300">{error}</p>}
          <button
            type="button"
            onClick={onConfirm}
            disabled={working}
            className={primaryBtn}
          >
            {working ? "Confirming…" : "Confirm paycheck"}
          </button>
        </>
      )}
    </div>
  );
}

function StepBills(props: {
  bills: BillRow[];
  total: MinorUnits;
  checked: Set<string>;
  onToggle: (key: string) => void;
  working: boolean;
  onDone: () => void;
}) {
  const { bills, total, checked, onToggle, working, onDone } = props;
  const currency = bills[0]?.currency ?? "USD";
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="font-display text-lg text-stone-900 dark:text-stone-100">Set aside bills</h3>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          {bills.length === 0
            ? "No bills due this pay cycle."
            : `${bills.length} bill${bills.length === 1 ? "" : "s"} due this cycle · ${formatMoney(total, currency)} total`}
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {bills.map((b) => {
          const checkedState = checked.has(b.key);
          return (
            <li key={b.key}>
              <button
                type="button"
                onClick={() => onToggle(b.key)}
                aria-pressed={checkedState}
                className={`flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors ${
                  checkedState
                    ? "border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950"
                    : "border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 hover:bg-stone-50 dark:hover:bg-stone-800"
                }`}
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] ${
                    checkedState
                      ? "border-emerald-600 dark:border-emerald-500 bg-emerald-600 dark:bg-emerald-500 text-white"
                      : "border-stone-300 dark:border-stone-600 text-transparent"
                  }`}
                >
                  ✓
                </span>
                <span className="flex-1">
                  <span className="block text-sm font-medium text-stone-900 dark:text-stone-100">{b.name}</span>
                  <span className="block text-xs text-stone-500 dark:text-stone-400">Due {prettyDate(b.date)}</span>
                </span>
                <span className="text-sm font-medium text-stone-900 dark:text-stone-100">
                  {formatMoney(b.amount, b.currency)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" onClick={onDone} disabled={working} className={primaryBtn}>
        {working ? "Saving…" : "Bills set aside"}
      </button>
    </div>
  );
}

function StepGoals(props: {
  rows: GoalRow[];
  run: PaydayRunState;
  spendable: Account[];
  sources: Record<string, string>;
  onSource: (goalId: string, accountId: string) => void;
  defaultSourceFor: (goal: Goal) => string;
  error: string | null;
  working: boolean;
  onFund: (row: GoalRow) => void;
  onContinue: () => void;
}) {
  const { rows, run, spendable, sources, onSource, defaultSourceFor, error, working, onFund, onContinue } = props;
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="font-display text-lg text-stone-900 dark:text-stone-100">Fund goals</h3>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          This cycle's contribution for each goal. Funding is a transfer — it never counts as spending.
        </p>
      </div>
      {rows.length === 0 && (
        <p className="rounded-2xl border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800 p-4 text-sm text-stone-500 dark:text-stone-400">
          No active goals. You can continue.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {rows.map((row) => {
          const fundedInRun = !!run.steps.goalContributions[row.goal.id];
          const onTrack = row.remainder <= 0;
          const sourceId = sources[row.goal.id] ?? defaultSourceFor(row.goal);
          return (
            <li
              key={row.goal.id}
              className="rounded-2xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4"
            >
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-stone-900 dark:text-stone-100">{row.goal.name}</p>
                <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
                  {formatMoney(row.contribution, row.goal.currency)}
                </p>
              </div>
              <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
                {formatMoney(row.funded, row.goal.currency)} already funded this cycle
              </p>
              {fundedInRun || onTrack ? (
                <p className="mt-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                  {onTrack && !fundedInRun ? "On track — nothing due this cycle." : "Funded this run."}
                </p>
              ) : (
                <div className="mt-3 flex flex-col gap-2">
                  <div className="flex gap-2">
                    <select
                      aria-label={`Source account for ${row.goal.name}`}
                      value={sourceId}
                      onChange={(e) => onSource(row.goal.id, e.target.value)}
                      className={`${fieldCls} flex-1`}
                    >
                      {spendable.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => onFund(row)}
                      disabled={working || !sourceId}
                      className="rounded-full bg-stone-900 dark:bg-stone-100 px-5 py-2.5 text-sm font-medium text-white dark:text-stone-900 transition-colors hover:bg-stone-700 dark:hover:bg-stone-200 disabled:opacity-60"
                    >
                      {working ? "…" : `Fund ${formatMoney(row.remainder, row.goal.currency)}`}
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="text-sm font-medium text-red-700 dark:text-red-300">{error}</p>}
      <button type="button" onClick={onContinue} disabled={working} className={secondaryBtn}>
        {working ? "Saving…" : "Continue"}
      </button>
    </div>
  );
}

function StepCards(props: {
  cards: { account: Account; owed: MinorUnits }[];
  spendable: Account[];
  sourceId: string;
  setSourceId: (v: string) => void;
  amounts: Record<string, string>;
  setAmount: (id: string, v: string) => void;
  error: string | null;
  working: boolean;
  onPay: (id: string, owed: MinorUnits, currency: string) => void;
  onSkip: () => void;
}) {
  const { cards, spendable, sourceId, setSourceId, amounts, setAmount, error, working, onPay, onSkip } = props;
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="font-display text-lg text-stone-900 dark:text-stone-100">Pay down cards</h3>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Card payments are transfers, never expenses.
        </p>
      </div>
      {cards.length === 0 ? (
        <p className="rounded-2xl border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800 p-4 text-sm text-stone-500 dark:text-stone-400">
          No card balances owed. Nothing to pay.
        </p>
      ) : (
        <>
          <div>
            <label htmlFor="pr-card-source" className={labelCls}>
              Pay from
            </label>
            <select
              id="pr-card-source"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              className={fieldCls}
            >
              <option value="">Choose…</option>
              {spendable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <ul className="flex flex-col gap-2">
            {cards.map(({ account, owed }) => {
              const value = amounts[account.id] ?? minorToInput(owed, account.currency);
              return (
                <li
                  key={account.id}
                  className="rounded-2xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-sm font-medium text-stone-900 dark:text-stone-100">{account.name}</p>
                    <p className="text-sm text-stone-500 dark:text-stone-400">
                      Owes {formatMoney(owed, account.currency)}
                    </p>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <input
                      type="text"
                      inputMode="decimal"
                      aria-label={`Payment amount for ${account.name}`}
                      value={value}
                      onChange={(e) => setAmount(account.id, e.target.value)}
                      className={fieldCls}
                    />
                    <button
                      type="button"
                      onClick={() => onPay(account.id, owed, account.currency)}
                      disabled={working}
                      className="shrink-0 rounded-full bg-stone-900 dark:bg-stone-100 px-5 py-2.5 text-sm font-medium text-white dark:text-stone-900 transition-colors hover:bg-stone-700 dark:hover:bg-stone-200 disabled:opacity-60"
                    >
                      {working ? "…" : "Record payment"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {error && <p className="text-sm font-medium text-red-700 dark:text-red-300">{error}</p>}
      <button type="button" onClick={onSkip} disabled={working} className={secondaryBtn}>
        {working ? "Saving…" : "Skip"}
      </button>
    </div>
  );
}

function StepDailyNumber(props: {
  daily: MinorUnits | null;
  currency: string;
  working: boolean;
  onComplete: () => void;
}) {
  const { daily, currency, working, onComplete } = props;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-8 text-center">
      <h3 className="font-display text-lg text-stone-900 dark:text-stone-100">Your new daily number</h3>
      {daily === null ? (
        <p className="text-sm text-stone-500 dark:text-stone-400">Recalculating…</p>
      ) : (
        <>
          <p className="font-display text-5xl text-stone-900 dark:text-stone-100">{formatMoney(daily, currency)}</p>
          <p className="max-w-xs text-sm text-stone-500 dark:text-stone-400">
            Safe to spend per day for the rest of this pay cycle.
          </p>
        </>
      )}
      <button
        type="button"
        onClick={onComplete}
        disabled={working || daily === null}
        className={`${primaryBtn} w-full`}
      >
        {working ? "Completing…" : "Complete run"}
      </button>
    </div>
  );
}

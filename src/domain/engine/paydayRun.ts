/**
 * Payday run helpers.
 *
 * Confirming a payday updates the generated Scheduled income row in place:
 * it never creates a second income transaction. Completing the run (or
 * confirming the payday) is the application's signal to recalculate and
 * overwrite today's DailySnapshot — the app layer does this via
 * refreshTodaySnapshot() in app/dashboard.ts, which the Phase 5 Payday
 * Run screen calls after confirmPaydayIncome / completePaydayRun.
 */
import type { DateOnly } from "../dates/dateOnly.js";
import { compareDateOnly } from "../dates/dateOnly.js";
import type { MinorUnits } from "../money/money.js";
import type { RecurringRule } from "../entities/recurringRule.js";
import type { Transaction, TransactionStatus } from "../entities/transaction.js";
import { countsAsIncome } from "../entities/transaction.js";
import type { PaydayRunState } from "../entities/settings.js";

export function createPaydayRunState(
  payDate: DateOnly,
  expectedAmount: MinorUnits,
  nowIso: string,
): PaydayRunState {
  return {
    id: crypto.randomUUID(),
    payDate,
    expectedAmount,
    steps: {
      billsSetAside: false,
      goalContributions: {},
      goalsStepDone: false,
      cardPaymentDone: false,
      paycheckSkipped: false,
    },
    completed: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export interface PaydayConfirmation {
  transactions: Transaction[];
  /** True when a matching Scheduled row was found and updated. */
  confirmed: boolean;
}

/**
 * Confirm a generated payday occurrence. Finds the Scheduled income
 * transaction for (ruleId, occurrenceDate) and flips it to Cleared (or
 * Pending), applying the confirmed amount. The row is updated in place;
 * no second income transaction is ever created.
 */
export function confirmPaydayIncome(
  transactions: readonly Transaction[],
  ruleId: string,
  occurrenceDate: DateOnly,
  confirmedAmount: MinorUnits,
  status: Extract<TransactionStatus, "Cleared" | "Pending">,
  nowIso: string,
): PaydayConfirmation {
  let confirmed = false;
  const next = transactions.map((t) => {
    if (
      t.recurringRuleId === ruleId &&
      t.occurrenceDate === occurrenceDate &&
      countsAsIncome(t) &&
      t.status === "Scheduled"
    ) {
      confirmed = true;
      return { ...t, amount: confirmedAmount, status, updatedAt: nowIso };
    }
    return t;
  });
  return { transactions: next, confirmed };
}

/** Mark a payday run completed. */
export function completePaydayRun(run: PaydayRunState, nowIso: string): PaydayRunState {
  return { ...run, completed: true, updatedAt: nowIso };
}

export interface CardPaymentInput {
  cardId: string;
  sourceAccountId: string;
  sourceCurrency: string;
  cardName: string;
  amount: MinorUnits;
  today: DateOnly;
  cycleStart: DateOnly;
  cycleEnd: DateOnly;
  nowIso: string;
}

export interface CardPaymentSettlement {
  transactions: Transaction[];
  /** True when an open Scheduled row for this card this cycle was found
   * and settled in place. False when a new Transfer was created. */
  settledScheduled: boolean;
  /** Id of the settled row, or of the newly created transfer. */
  transactionId: string;
}

/**
 * Record a credit-card payment from the Payday Run card step.
 *
 * If an open Scheduled row for this card exists in the current pay cycle
 * — a Scheduled Transfer whose rule is a debt-payment rule with
 * payToAccountId === cardId — it is settled in place (entered amount,
 * today's date, status -> Cleared): no second Transfer is created. Debt
 * payments are Transfers, never Expenses, so the type and
 * transferToAccountId are preserved either way. Otherwise a new Cleared
 * Transfer for today is created.
 */
export function settleCardPayment(
  transactions: readonly Transaction[],
  rules: readonly RecurringRule[],
  input: CardPaymentInput,
): CardPaymentSettlement {
  // A card can never be paid from itself.
  if (input.sourceAccountId === input.cardId) {
    throw new Error("Pick a different account than the one being paid.");
  }
  const rulesById = new Map(rules.map((r) => [r.id, r]));
  const candidate = transactions
    .filter(
      (t) =>
        t.status === "Scheduled" &&
        t.type === "Transfer" &&
        t.recurringRuleId !== undefined &&
        t.occurrenceDate !== undefined &&
        rulesById.get(t.recurringRuleId)?.payToAccountId === input.cardId &&
        compareDateOnly(t.occurrenceDate, input.cycleStart) >= 0 &&
        compareDateOnly(t.occurrenceDate, input.cycleEnd) <= 0,
    )
    .sort((a, b) => compareDateOnly(a.occurrenceDate as DateOnly, b.occurrenceDate as DateOnly))[0];
  if (candidate) {
    const settled: Transaction = {
      ...candidate,
      amount: input.amount,
      date: input.today,
      status: "Cleared",
      updatedAt: input.nowIso,
    };
    return {
      transactions: transactions.map((t) => (t.id === candidate.id ? settled : t)),
      settledScheduled: true,
      transactionId: settled.id,
    };
  }
  const payment: Transaction = {
    id: crypto.randomUUID(),
    type: "Transfer",
    amount: input.amount,
    currency: input.sourceCurrency,
    date: input.today,
    accountId: input.sourceAccountId,
    categoryId: null,
    payee: `Card payment: ${input.cardName}`,
    status: "Cleared",
    notes: "Payday run",
    tags: [],
    // Credit-card payments are transfers, never expenses.
    transferToAccountId: input.cardId,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  };
  return {
    transactions: [...transactions, payment],
    settledScheduled: false,
    transactionId: payment.id,
  };
}

/**
 * First incomplete checklist step for a run: 1 = paycheck not confirmed
 * (no confirmedAmount and not skipped), 2 = bills not set aside, 3 = goals step not
 * finished (user pressed Continue or funded everything needing money),
 * 4 = card step not addressed, 5 = all prior steps done — the run is
 * ready for its new daily number. A completed run also returns 5; the
 * caller handles completed runs (summary view) separately.
 */
export function nextIncompleteStep(run: PaydayRunState): 1 | 2 | 3 | 4 | 5 {
  if (run.confirmedAmount === undefined && !run.steps.paycheckSkipped) return 1;
  if (!run.steps.billsSetAside) return 2;
  if (!run.steps.goalsStepDone) return 3;
  if (!run.steps.cardPaymentDone) return 4;
  return 5;
}

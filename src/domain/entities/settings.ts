import type { DateOnly } from "../dates/dateOnly.js";
import type { MinorUnits } from "../money/money.js";

export interface Settings {
  id: "settings"; // singleton row
  baseCurrency: string;
  bufferAmount: MinorUnits; // optional safety buffer, default 0
  theme: "system" | "light" | "dark";
  lastBackupAt?: string; // drives the 30-day backup reminder
  // Irregular income fallback, used when no primary payday is set
  nextExpectedIncomeDate?: DateOnly;
  nextExpectedIncomeAmount?: MinorUnits;
  notificationsEnabled: boolean;
  /**
   * True once the first-launch flow has finished (or was skipped). The
   * onboarding gate shows when this is false AND the database has no
   * accounts; existing users with data but no flag are treated as
   * onboarded (the flag is set for them silently on launch).
   */
  onboardingCompleted: boolean;
  // Last-used FX rate per pair ("EUR->USD" -> rate), persisted so the
  // converter can fall back to it when an account has no fxRateToBase.
  lastUsedFxRates?: Record<string, number>;
}

// Start-of-day safe-to-spend snapshot. Written once when the day's number
// is first calculated; "Left today" is derived from it minus today's
// spending, so the headline number stays fixed through the day even as
// balances move. The snapshot is recalculated and overwritten for today
// when the Payday Run completes, or when a payday occurrence is confirmed,
// because the pay cycle and available funds have materially changed.
export interface DailySnapshot {
  id: string; // the DateOnly, e.g. "2026-10-15"
  date: DateOnly;
  startOfDayAmount: MinorUnits;
  available: MinorUnits;
  committed: MinorUnits;
  daysLeft: number;
  createdAt: string;
}

// Working state for the guided payday checklist. Progress survives leaving
// partway through; completing the run logs the resulting transfers.
// Completing the run, or confirming the payday from the run's first step,
// triggers recalculation and overwrite of today's DailySnapshot.
export interface PaydayRunState {
  id: string;
  payDate: DateOnly;
  expectedAmount: MinorUnits;
  confirmedAmount?: MinorUnits; // adjusted if the actual check differs
  steps: {
    billsSetAside: boolean;
    goalContributions: Record<string, boolean>; // goalId -> funded
    /**
     * The goals step is explicitly skippable: it completes when the user
     * presses Continue (or funds every goal needing money this cycle),
     * not when every goal is funded. Never derived from goalContributions.
     */
    goalsStepDone: boolean;
    cardPaymentDone: boolean;
  };
  completed: boolean;
  createdAt: string;
  updatedAt: string;
}

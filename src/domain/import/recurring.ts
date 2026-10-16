/**
 * Recurring-charge detection (Phase B2): finds bills and subscriptions in
 * imported history by merchant + schedule consistency.
 *
 * A pattern is "clear" (auto-create) when one merchant has at least 3
 * charges on a consistent weekly, monthly, or yearly schedule. Weaker
 * patterns (2 charges, or 3+ with a wobble) become review suggestions.
 * Varying amounts (utilities) still count; the rule uses the recent
 * average and is marked variable.
 */
import type { DateOnly } from "../dates/dateOnly.js";
import { addDays, addMonthsClamped, diffDays } from "../dates/dateOnly.js";
import type { Frequency } from "../entities/recurringRule.js";
import type { MinorUnits } from "../money/money.js";

export type DetectedCadence = "weekly" | "monthly" | "yearly";

export interface RecurringCharge {
  transactionId: string;
  date: DateOnly;
  amount: MinorUnits;
  merchantKey: string;
  payee: string;
  categoryId: string | null;
  accountId: string;
}

export interface RecurringCandidate {
  merchantKey: string;
  merchantName: string;
  categoryId: string | null;
  /** Most common account — the rule books here. */
  accountId: string;
  cadence: DetectedCadence;
  frequency: Frequency;
  charges: RecurringCharge[];
  /** Recent average (last 3, or all) — the rule's upcoming amount. */
  avgAmount: MinorUnits;
  amountVaries: boolean;
  strength: "auto" | "suggest";
  /** First charge date, for "since March 2024" messaging. */
  since: DateOnly;
}

const CADENCE_WINDOWS: Array<{
  cadence: DetectedCadence;
  frequency: Frequency;
  min: number;
  max: number;
}> = [
  { cadence: "weekly", frequency: "weekly", min: 5, max: 9 },
  { cadence: "monthly", frequency: "monthly", min: 26, max: 35 },
  { cadence: "yearly", frequency: "annual", min: 350, max: 380 },
];

function fitsCadence(days: number): DetectedCadence | null {
  for (const w of CADENCE_WINDOWS) {
    if (days >= w.min && days <= w.max) return w.cadence;
  }
  return null;
}

function avgMinor(amounts: MinorUnits[]): MinorUnits {
  const sum = amounts.reduce((a, b) => a + b, 0);
  return Math.round(sum / amounts.length);
}

export function detectRecurring(charges: RecurringCharge[]): RecurringCandidate[] {
  const byMerchant = new Map<string, RecurringCharge[]>();
  for (const c of charges) {
    const list = byMerchant.get(c.merchantKey) ?? [];
    list.push(c);
    byMerchant.set(c.merchantKey, list);
  }

  const out: RecurringCandidate[] = [];
  for (const [merchantKey, list] of byMerchant) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => (a.date < b.date ? -1 : 1));
    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      intervals.push(diffDays(sorted[i - 1]!.date, sorted[i]!.date));
    }
    const cadences = intervals.map(fitsCadence);
    const first = cadences[0];
    const allFit = first !== null && cadences.every((c) => c === first);

    let strength: "auto" | "suggest" | null = null;
    if (sorted.length >= 3 && allFit) {
      strength = "auto";
    } else if (sorted.length === 2 && allFit) {
      strength = "suggest";
    } else if (sorted.length >= 3 && !allFit) {
      // Mostly consistent with one wobble: worth suggesting, not auto.
      const fitCount = cadences.filter((c) => c === first).length;
      if (first !== null && fitCount >= intervals.length - 1) strength = "suggest";
    }
    if (strength === null || first == null) continue;

    const window = CADENCE_WINDOWS.find((w) => w.cadence === first)!;
    const recent = sorted.slice(-3).map((c) => c.amount);
    const avg = avgMinor(recent);
    const all = sorted.map((c) => c.amount);
    const min = Math.min(...all);
    const max = Math.max(...all);
    const amountVaries = avg === 0 ? false : (max - min) / avg > 0.2;

    // Most common account and category win.
    const accountVotes = new Map<string, number>();
    const categoryVotes = new Map<string, number>();
    for (const c of sorted) {
      accountVotes.set(c.accountId, (accountVotes.get(c.accountId) ?? 0) + 1);
      if (c.categoryId) categoryVotes.set(c.categoryId, (categoryVotes.get(c.categoryId) ?? 0) + 1);
    }
    const top = (m: Map<string, number>): string | null => {
      let best: string | null = null;
      let bestN = 0;
      for (const [k, n] of m) {
        if (n > bestN) {
          best = k;
          bestN = n;
        }
      }
      return best;
    };

    out.push({
      merchantKey,
      merchantName: sorted[sorted.length - 1]!.payee,
      categoryId: top(categoryVotes),
      accountId: top(accountVotes) ?? sorted[0]!.accountId,
      cadence: first,
      frequency: window.frequency,
      charges: sorted,
      avgAmount: avg,
      amountVaries,
      strength,
      since: sorted[0]!.date,
    });
  }
  return out.sort((a, b) => (a.merchantName < b.merchantName ? -1 : 1));
}

/**
 * Next expected charge date after the last seen charge. Used to spot a
 * missed period (possibly cancelled).
 */
export function nextExpectedDate(lastDate: DateOnly, cadence: DetectedCadence): DateOnly {
  if (cadence === "weekly") return addDays(lastDate, 7);
  if (cadence === "monthly") return addMonthsClamped(lastDate, 1);
  return addMonthsClamped(lastDate, 12);
}

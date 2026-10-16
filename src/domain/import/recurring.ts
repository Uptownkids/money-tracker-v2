/**
 * Recurring-charge detection (Phase B2): finds bills and subscriptions in
 * imported history by merchant + schedule consistency.
 *
 * For each merchant, FIRST check whether ALL its charges form one
 * consistent monthly schedule (about one charge per month). If so it is a
 * single bill — fixed when the amounts sit within ~10%, variable
 * (utilities, phone) when they spread wider. Seasonal variable bills must
 * not be split into fake fixed streams.
 *
 * Only when a merchant has more than one charge per cycle (e.g. Apple
 * $2.99 + $10.99 in the same month) do we split by amount: charges
 * within ~10% of the cluster minimum form one stream. A stream is "clear"
 * (auto-create) with 3+ charges on a consistent weekly/monthly/yearly
 * schedule — except weekly, which needs 4+. Weaker streams (2 charges, or
 * 3+ with a wobble) become review suggestions. Variable amounts never
 * auto-create on weekly or yearly schedules.
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

/**
 * Two (merchant, amount) pairs belong to the same charge stream when the
 * merchant matches and the amounts are within 10% of each other.
 */
export function sameStream(
  merchantKeyA: string,
  amountA: MinorUnits,
  merchantKeyB: string,
  amountB: MinorUnits,
): boolean {
  if (merchantKeyA !== merchantKeyB) return false;
  if (amountA === 0 || amountB === 0) return amountA === amountB;
  return Math.abs(amountA - amountB) / Math.max(amountA, amountB) <= 0.1;
}

/** String key for one amount-stream: `${merchantKey}|${cents}`. */
export function streamKey(merchantKey: string, amount: MinorUnits): string {
  return `${merchantKey}|${Math.round(amount)}`;
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

/** Most common value wins (for account / category votes). */
function topVote(m: Map<string, number>): string | null {
  let best: string | null = null;
  let bestN = 0;
  for (const [k, n] of m) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

function buildCandidate(
  merchantKey: string,
  charges: RecurringCharge[],
  cadence: DetectedCadence,
  strength: "auto" | "suggest",
  amountVaries: boolean,
): RecurringCandidate {
  const sorted = [...charges].sort((a, b) => (a.date < b.date ? -1 : 1));
  const window = CADENCE_WINDOWS.find((w) => w.cadence === cadence)!;
  const recent = sorted.slice(-3).map((c) => c.amount);
  const accountVotes = new Map<string, number>();
  const categoryVotes = new Map<string, number>();
  for (const c of sorted) {
    accountVotes.set(c.accountId, (accountVotes.get(c.accountId) ?? 0) + 1);
    if (c.categoryId) categoryVotes.set(c.categoryId, (categoryVotes.get(c.categoryId) ?? 0) + 1);
  }
  return {
    merchantKey,
    merchantName: sorted[sorted.length - 1]!.payee,
    categoryId: topVote(categoryVotes),
    accountId: topVote(accountVotes) ?? sorted[0]!.accountId,
    cadence,
    frequency: window.frequency,
    charges: sorted,
    avgAmount: avgMinor(recent),
    amountVaries,
    strength,
    since: sorted[0]!.date,
  };
}

/**
 * Analyze one amount-cluster (charges already within ~10% of each other).
 * Weekly streams need 4+ charges to auto-create; monthly/yearly need 3+.
 */
function analyzeCluster(
  merchantKey: string,
  cluster: RecurringCharge[],
): RecurringCandidate | null {
  if (cluster.length < 2) return null;
  const sorted = [...cluster].sort((a, b) => (a.date < b.date ? -1 : 1));
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    intervals.push(diffDays(sorted[i - 1]!.date, sorted[i]!.date));
  }
  const cadences = intervals.map(fitsCadence);
  const first = cadences[0];
  if (first == null) return null;
  const allFit = cadences.every((c) => c === first);

  let strength: "auto" | "suggest" | null = null;
  if (allFit) {
    if (first === "weekly") {
      strength = sorted.length >= 4 ? "auto" : "suggest";
    } else {
      strength = sorted.length >= 3 ? "auto" : "suggest";
    }
  } else if (sorted.length >= 3) {
    // Mostly consistent with one wobble: worth suggesting, not auto.
    const fitCount = cadences.filter((c) => c === first).length;
    if (fitCount >= intervals.length - 1) strength = "suggest";
  }
  if (strength === null) return null;
  return buildCandidate(merchantKey, sorted, first, strength, false);
}

/** True when amounts sit within ~10% of each other (fixed stream). */
function amountsAreSimilar(amounts: MinorUnits[]): boolean {
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  if (min === 0) return max === 0;
  return (max - min) / min <= 0.1;
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

    // About one charge per month: a single bill. Fixed when the amounts
    // are similar, variable when they spread (seasonal utilities).
    // Never split these into amount streams.
    if (intervals.every((d) => fitsCadence(d) === "monthly")) {
      const strength = sorted.length >= 3 ? "auto" : "suggest";
      const amountVaries = !amountsAreSimilar(sorted.map((c) => c.amount));
      out.push(buildCandidate(merchantKey, sorted, "monthly", strength, amountVaries));
      continue;
    }

    // More than one charge per cycle: split into amount streams.
    const byAmount = [...list].sort((a, b) => a.amount - b.amount);
    const clusters: RecurringCharge[][] = [];
    for (const c of byAmount) {
      const cluster = clusters[clusters.length - 1];
      const min = cluster?.[0]?.amount ?? 0;
      if (cluster && cluster.length > 0 && (min === 0 ? c.amount === 0 : (c.amount - min) / min <= 0.1)) {
        cluster.push(c);
      } else {
        clusters.push([c]);
      }
    }

    for (const cluster of clusters) {
      const candidate = analyzeCluster(merchantKey, cluster);
      if (candidate) out.push(candidate);
    }
    // Clusters that form no pattern are scattered one-off charges: ignored.
    // (Variable amounts only qualify as one bill when the merchant is about
    // one charge per month — handled above.)
  }
  return out.sort((a, b) =>
    a.merchantName < b.merchantName ? -1 : a.merchantName > b.merchantName ? 1 : a.avgAmount - b.avgAmount,
  );
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

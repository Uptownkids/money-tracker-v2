/**
 * Phase B2: automatic bill/subscription detection and rule management.
 *
 * Runs after each import commit:
 *  1. Detects recurring merchants among untagged expenses.
 *  2. Auto-creates Subscription/Bill rules for clear patterns (>=3
 *     charges, consistent schedule), tags all past matching charges, and
 *     reports "Now tracking ..." for one-tap undo.
 *  3. Sends weak patterns to the review inbox as suggestions.
 *  4. Flags changes: price increases, missed expected charges (ends the
 *     rule), and resurrected merchants.
 *
 * Undo removes the rule, untags past charges, and deletes future
 * Scheduled rows — but never deletes the transactions themselves.
 */
import type { Repositories } from "../data/repositories/index.js";
import type { DateOnly } from "../domain/dates/dateOnly.js";
import { compareDateOnly, diffDays, todayLocal } from "../domain/dates/dateOnly.js";
import type { RecurringRule } from "../domain/entities/recurringRule.js";
import type { Transaction } from "../domain/entities/transaction.js";
import { merchantKey } from "../domain/import/payeeClean.js";
import {
  detectRecurring,
  nextExpectedDate,
  sameStream,
  streamKey,
  type DetectedCadence,
  type RecurringCandidate,
  type RecurringCharge,
} from "../domain/import/recurring.js";

/** Merchant keywords that mark an auto-created rule a Subscription. */
const SUBSCRIPTION_KEYWORDS = [
  "SPOTIFY",
  "NETFLIX",
  "HULU",
  "DISNEY",
  "APPLE",
  "ICLOUD",
  "GOOGLE",
  "YOUTUBE",
  "PRIME",
  "AUDIBLE",
  "GYM",
  "FITNESS",
  "PELOTON",
  "NYTIMES",
  "NEW YORKER",
  "WASHINGTON POST",
  "MEDIUM",
  "DROPBOX",
  "EVERNOTE",
  "ADOBE",
  "MICROSOFT",
  "XBOX",
  "PLAYSTATION",
  "NINTENDO",
];

const PRICE_CHANGE_THRESHOLD = 0.15; // 15% vs the rule amount
const MISSED_GRACE_DAYS = 7;

export interface CreatedRuleInfo {
  ruleId: string;
  message: string;
  taggedCount: number;
}

export interface DetectionOutcome {
  created: CreatedRuleInfo[];
  /** Patterns whose last charge predates the data: ended rules, history only. */
  pastSubscriptions: number;
  suggested: number;
  flagged: number;
}

function kindFor(candidate: RecurringCandidate): "Bill" | "Subscription" {
  if (SUBSCRIPTION_KEYWORDS.some((k) => candidate.merchantKey.includes(k))) return "Subscription";
  // Fixed-amount personal services read as subscriptions; varying amounts
  // (utilities, phone) read as bills.
  return candidate.amountVaries ? "Bill" : "Subscription";
}

function monthName(d: DateOnly): string {
  const names = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const m = Number(d.slice(5, 7));
  return `${names[m - 1]} ${d.slice(0, 4)}`;
}

function money(amount: number): string {
  return `$${(amount / 100).toFixed(2)}`;
}

function cadenceLabel(c: DetectedCadence): string {
  return c === "weekly" ? "weekly" : c === "monthly" ? "monthly" : "yearly";
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Build detection charges from untagged cleared expenses. Merchant keys
 * are recomputed from the (cleaned) payee.
 */
export function chargesFromTransactions(transactions: readonly Transaction[]): RecurringCharge[] {
  const out: RecurringCharge[] = [];
  for (const t of transactions) {
    if (t.type !== "Expense") continue;
    if (t.status !== "Cleared") continue;
    if (t.recurringRuleId) continue;
    const key = merchantKey(t.payee);
    if (!key) continue;
    out.push({
      transactionId: t.id,
      date: t.date,
      amount: t.amount,
      merchantKey: key,
      payee: t.payee,
      categoryId: t.categoryId,
      accountId: t.accountId,
    });
  }
  return out;
}

async function dismissedMerchants(repos: Repositories): Promise<Set<string>> {
  const s = await repos.settings.get();
  return new Set(s?.recurringDismissed ?? []);
}

async function dismissMerchant(repos: Repositories, merchantKey: string): Promise<void> {
  const s = await repos.settings.get();
  if (!s) return;
  const dismissed = new Set(s.recurringDismissed ?? []);
  dismissed.add(merchantKey);
  await repos.settings.save({ ...s, recurringDismissed: [...dismissed] });
}

/**
 * Latest BANK-IMPORTED transaction date in an account's data. Only rows
 * with an importBatchId count — manually logged and Quick-Log entries are
 * the user's own bookkeeping, not the bank's record of what happened.
 * Missed-charge checks measure against this — never against today — so
 * importing an older or stale CSV can never end an active rule.
 */
async function latestDataDate(
  repos: Repositories,
  accountId: string,
  fallback: DateOnly,
): Promise<DateOnly> {
  const txs = await repos.transactions.byAccount(accountId);
  let latest: DateOnly | null = null;
  for (const t of txs) {
    if (!t.importBatchId) continue;
    if (t.status !== "Cleared" && t.status !== "Pending") continue;
    if (latest === null || compareDateOnly(t.date, latest) > 0) latest = t.date;
  }
  return latest ?? fallback;
}

/**
 * Among a merchant's rules, the one whose amount best matches a charge.
 * Used so multi-stream merchants (Apple $2.99 and $10.99) resolve flags
 * against the right rule.
 */
export function findClosestRule(
  rules: readonly RecurringRule[],
  merchantKey: string,
  amount: number,
): RecurringRule | undefined {
  let best: RecurringRule | undefined;
  let bestDiff = Infinity;
  for (const r of rules) {
    if (r.merchantKey !== merchantKey) continue;
    const diff = Math.abs(r.amount - amount);
    if (diff < bestDiff) {
      best = r;
      bestDiff = diff;
    }
  }
  return best;
}

/** True when a candidate's stream was dismissed (exact stream key, or a bare merchant key dismisses all streams). */
function isStreamDismissed(dismissed: Set<string>, c: RecurringCandidate): boolean {
  if (dismissed.has(c.merchantKey)) return true;
  return dismissed.has(streamKey(c.merchantKey, c.avgAmount));
}

/** True when an auto rule already tracks a candidate's stream. */
function streamAlreadyTracked(rules: readonly RecurringRule[], c: RecurringCandidate): boolean {
  return rules.some((r) => sameStream(r.merchantKey ?? "", r.amount, c.merchantKey, c.avgAmount));
}

/**
 * Dry-run detection for the pre-commit summary: how many rules would be
 * auto-created, how many are already-ended history, and how many
 * suggestions raised. No writes.
 */
export async function previewRecurringDetection(
  repos: Repositories,
  today: DateOnly = todayLocal(),
): Promise<{ wouldCreate: number; wouldSuggest: number; wouldEnd: number }> {
  const dismissed = await dismissedMerchants(repos);
  const rules = await repos.recurringRules.getAll();
  const allTx = await repos.transactions.getAll();
  const candidates = detectRecurring(chargesFromTransactions(allTx));
  let wouldCreate = 0;
  let wouldSuggest = 0;
  let wouldEnd = 0;
  for (const c of candidates) {
    if (isStreamDismissed(dismissed, c) || streamAlreadyTracked(rules, c)) continue;
    if (c.strength === "suggest") {
      wouldSuggest++;
      continue;
    }
    const refDate = await latestDataDate(repos, c.accountId, today);
    const lastCharge = c.charges[c.charges.length - 1]!;
    if (diffDays(nextExpectedDate(lastCharge.date, c.cadence), refDate) > MISSED_GRACE_DAYS) {
      wouldEnd++;
    } else {
      wouldCreate++;
    }
  }
  return { wouldCreate, wouldSuggest, wouldEnd };
}

/**
 * Detect and auto-create rules. `newTransactions` are the just-imported
 * rows (for change flags); detection itself scans all untagged expenses.
 *
 * A clear pattern whose last charge already predates the imported data
 * (stale) is created directly as an ended, history-only rule: no
 * "Now tracking" message and no "possibly cancelled" flag. The count
 * lands in `outcome.pastSubscriptions` for the import summary.
 */
export async function detectAndCreateRules(
  repos: Repositories,
  newTransactions: readonly Transaction[],
  today: DateOnly = todayLocal(),
): Promise<DetectionOutcome> {
  const outcome: DetectionOutcome = { created: [], pastSubscriptions: 0, suggested: 0, flagged: 0 };
  const dismissed = await dismissedMerchants(repos);
  const rules = await repos.recurringRules.getAll();

  // --- 1+2. Detect + auto-create ---
  const allTx = await repos.transactions.getAll();
  const candidates = detectRecurring(chargesFromTransactions(allTx));
  for (const c of candidates) {
    if (isStreamDismissed(dismissed, c)) continue;
    if (streamAlreadyTracked(rules, c)) continue;
    if (c.strength === "suggest") {
      await suggestRecurring(repos, c);
      outcome.suggested++;
      continue;
    }
    const lastCharge = c.charges[c.charges.length - 1]!;
    const refDate = await latestDataDate(repos, c.accountId, today);
    if (diffDays(nextExpectedDate(lastCharge.date, c.cadence), refDate) > MISSED_GRACE_DAYS) {
      // Stale pattern: history-only ended rule, no fanfare.
      const info = await createRule(repos, c, { ended: true });
      outcome.pastSubscriptions++;
      rules.push((await repos.recurringRules.getById(info.ruleId))!);
      continue;
    }
    const info = await createRule(repos, c);
    outcome.created.push(info);
    rules.push((await repos.recurringRules.getById(info.ruleId))!);
  }

  // --- 4. Change flags ---
  outcome.flagged += await flagPriceIncreases(repos, newTransactions);
  outcome.flagged += await flagMissedCharges(repos, today);
  outcome.flagged += await flagResurrected(repos, newTransactions);

  return outcome;
}

export async function createRule(
  repos: Repositories,
  c: RecurringCandidate,
  opts?: { ended?: boolean },
): Promise<CreatedRuleInfo> {
  const now = nowIso();
  const lastCharge = c.charges[c.charges.length - 1]!;
  const nextDue = nextExpectedDate(lastCharge.date, c.cadence);
  const rule: RecurringRule = {
    id: crypto.randomUUID(),
    kind: kindFor(c),
    name: c.merchantName,
    amount: c.avgAmount,
    currency: "USD",
    accountId: c.accountId,
    categoryId: c.categoryId ?? (await fallbackCategory(repos)),
    frequency: c.frequency,
    nextDueDate: nextDue,
    weekendShift: "none",
    autoPay: false,
    reminderOffsetDays: 3,
    isVariableAmount: c.amountVaries,
    skippedDates: [],
    merchantKey: c.merchantKey,
    autoCreated: true,
    autoCreatedAt: now,
    // Stale patterns are history only: ended on creation, no future rows.
    active: !opts?.ended,
    endDate: opts?.ended ? nextDue : undefined,
    createdAt: now,
    updatedAt: now,
  };
  await repos.recurringRules.put(rule);

  // Tag all past matching charges with the rule.
  let tagged = 0;
  for (const charge of c.charges) {
    const tx = await repos.transactions.getById(charge.transactionId);
    if (!tx || tx.recurringRuleId) continue;
    await repos.transactions.put({ ...tx, recurringRuleId: rule.id, updatedAt: now });
    tagged++;
  }

  return {
    ruleId: rule.id,
    message: `Now tracking ${c.merchantName}, ${money(c.avgAmount)} ${cadenceLabel(c.cadence)}, since ${monthName(c.since)}`,
    taggedCount: tagged,
  };
}

async function fallbackCategory(repos: Repositories): Promise<string> {
  const cats = await repos.categories.getAll();
  const other = cats.find((c) => c.kind === "expense" && c.name.toLowerCase() === "other");
  const first = cats.find((c) => c.kind === "expense");
  if (!other && !first) throw new Error("detectAndCreateRules: no expense categories");
  return (other ?? first)!.id;
}

async function suggestRecurring(repos: Repositories, c: RecurringCandidate): Promise<void> {
  // Don't suggest the same stream twice.
  const open = await repos.reviewItems.open();
  for (const i of open) {
    if (!i.reasons.includes("weak-recurring") || i.merchantKey !== c.merchantKey) continue;
    const tx = await repos.transactions.getById(i.transactionId);
    if (tx && sameStream(i.merchantKey, tx.amount, c.merchantKey, c.avgAmount)) return;
  }
  const tx = await repos.transactions.getById(c.charges[c.charges.length - 1]!.transactionId);
  if (!tx) return;
  await repos.reviewItems.put({
    id: crypto.randomUUID(),
    transactionId: tx.id,
    status: "open",
    reasons: ["weak-recurring"],
    merchantKey: c.merchantKey,
    guess: {
      type: "Expense",
      categoryId: c.categoryId ?? undefined,
      payee: c.merchantName,
      billName: `${c.merchantName} (${cadenceLabel(c.cadence)}, ~${money(c.avgAmount)})`,
    },
    createdAt: nowIso(),
  });
}

/** Flag new charges that cost materially more than their rule (matched to the closest amount-stream). */
async function flagPriceIncreases(
  repos: Repositories,
  newTransactions: readonly Transaction[],
): Promise<number> {
  const rules = (await repos.recurringRules.getAll()).filter(
    (r) => r.active && r.autoCreated && r.merchantKey,
  );
  if (rules.length === 0) return 0;
  let flagged = 0;
  for (const t of newTransactions) {
    if (t.type !== "Expense" || t.status !== "Cleared") continue;
    const rule = findClosestRule(rules, merchantKey(t.payee), t.amount);
    if (!rule || rule.amount === 0) continue;
    const change = (t.amount - rule.amount) / rule.amount;
    if (change < PRICE_CHANGE_THRESHOLD) continue;
    const open = await repos.reviewItems.open();
    if (open.some((i) => i.transactionId === t.id && i.reasons.includes("price-increase"))) continue;
    await repos.reviewItems.put({
      id: crypto.randomUUID(),
      transactionId: t.id,
      status: "open",
      reasons: ["price-increase"],
      merchantKey: rule.merchantKey as string,
      guess: {
        type: "Expense",
        categoryId: rule.categoryId,
        payee: rule.name,
        billName: `${rule.name} rose to ${money(t.amount)} (was ${money(rule.amount)})`,
      },
      createdAt: nowIso(),
    });
    flagged++;
  }
  return flagged;
}

/**
 * Flag (and end) auto-created rules whose expected charge never arrived.
 * "Missed" is measured against the latest transaction date in the rule's
 * account data — never against today — so a stale import can never end
 * an active rule.
 * Ended rules keep history but generate no future Scheduled rows.
 */
async function flagMissedCharges(repos: Repositories, today: DateOnly): Promise<number> {
  const rules = (await repos.recurringRules.getAll()).filter(
    (r) => r.active && r.autoCreated && r.merchantKey,
  );
  let flagged = 0;
  for (const rule of rules) {
    const tagged = await repos.transactions.byRecurringRule(rule.id);
    if (tagged.length === 0) continue;
    const lastDate = tagged.map((t) => t.date).sort().pop() as DateOnly;
    const cadence: DetectedCadence =
      rule.frequency === "weekly" ? "weekly" : rule.frequency === "annual" ? "yearly" : "monthly";
    const refDate = await latestDataDate(repos, rule.accountId, today);
    const expected = nextExpectedDate(lastDate, cadence);
    if (diffDays(expected, refDate) <= MISSED_GRACE_DAYS) continue;
    // Ended: keep history, no future rows.
    const now = nowIso();
    await repos.recurringRules.put({ ...rule, active: false, endDate: expected, updatedAt: now });
    const open = await repos.reviewItems.open();
    if (open.some((i) => i.merchantKey === rule.merchantKey && i.reasons.includes("missed-charge"))) continue;
    const latest = tagged.find((t) => t.date === lastDate);
    if (!latest) continue;
    await repos.reviewItems.put({
      id: crypto.randomUUID(),
      transactionId: latest.id,
      status: "open",
      reasons: ["missed-charge"],
      merchantKey: rule.merchantKey as string,
      guess: {
        type: "Expense",
        categoryId: rule.categoryId,
        payee: rule.name,
        billName: `${rule.name} didn't charge as expected — possibly cancelled`,
      },
      createdAt: now,
    });
    flagged++;
  }
  return flagged;
}

/** Flag new charges from a merchant whose auto rule was ended (matched to the closest amount-stream). */
async function flagResurrected(
  repos: Repositories,
  newTransactions: readonly Transaction[],
): Promise<number> {
  const rules = (await repos.recurringRules.getAll()).filter(
    (r) => !r.active && r.autoCreated && r.merchantKey,
  );
  if (rules.length === 0) return 0;
  let flagged = 0;
  for (const t of newTransactions) {
    if (t.type !== "Expense" || t.status !== "Cleared" || t.recurringRuleId) continue;
    const rule = findClosestRule(rules, merchantKey(t.payee), t.amount);
    if (!rule) continue;
    const open = await repos.reviewItems.open();
    if (open.some((i) => i.transactionId === t.id && i.reasons.includes("resurrected-merchant"))) continue;
    await repos.reviewItems.put({
      id: crypto.randomUUID(),
      transactionId: t.id,
      status: "open",
      reasons: ["resurrected-merchant"],
      merchantKey: rule.merchantKey as string,
      guess: {
        type: "Expense",
        categoryId: rule.categoryId,
        payee: rule.name,
        billName: `${rule.name} charged again after ending`,
      },
      createdAt: nowIso(),
    });
    flagged++;
  }
  return flagged;
}

/**
 * One-tap undo for an auto-created rule: removes the rule, untags past
 * charges, deletes future Scheduled rows. Transactions are never deleted.
 * The merchant is dismissed so the detector won't recreate it.
 */
export async function undoRecurringRule(
  repos: Repositories,
  ruleId: string,
): Promise<{ untagged: number; removedScheduled: number }> {
  const rule = await repos.recurringRules.getById(ruleId);
  if (!rule) throw new Error(`undoRecurringRule: unknown rule "${ruleId}"`);
  if (!rule.autoCreated) throw new Error("undoRecurringRule: only auto-created rules can be undone here");
  const now = nowIso();
  const tagged = await repos.transactions.byRecurringRule(ruleId);
  let untagged = 0;
  let removedScheduled = 0;
  for (const t of tagged) {
    if (t.status === "Scheduled") {
      await repos.transactions.remove(t.id);
      removedScheduled++;
    } else {
      await repos.transactions.put({ ...t, recurringRuleId: undefined, updatedAt: now });
      untagged++;
    }
  }
  await repos.recurringRules.remove(ruleId);
  if (rule.merchantKey) await dismissMerchant(repos, streamKey(rule.merchantKey, rule.amount));
  return { untagged, removedScheduled };
}

/** Re-activate an ended rule (from a resurrected-merchant review). */
export async function reactivateRecurringRule(repos: Repositories, ruleId: string): Promise<void> {
  const rule = await repos.recurringRules.getById(ruleId);
  if (!rule) throw new Error(`reactivateRecurringRule: unknown rule "${ruleId}"`);
  const now = nowIso();
  await repos.recurringRules.put({
    ...rule,
    active: true,
    endDate: undefined,
    nextDueDate: nextExpectedDate(todayLocal(), "monthly"),
    updatedAt: now,
  });
}

/**
 * Create a rule from a weak-recurring suggestion (the user confirmed the
 * pattern). A manual confirmation only needs 2 charges; the >=3 bar is
 * for automatic creation. `amountHint` picks the right amount-stream when
 * one merchant has several.
 */
export async function createRuleForMerchant(
  repos: Repositories,
  merchantKey: string,
  amountHint?: number,
): Promise<CreatedRuleInfo | null> {
  const allTx = await repos.transactions.getAll();
  const charges = chargesFromTransactions(allTx).filter((c) => c.merchantKey === merchantKey);
  if (charges.length < 2) return null;
  const candidates = detectRecurring(charges);
  let candidate = candidates.find((c) => c.merchantKey === merchantKey);
  if (amountHint !== undefined && candidates.length > 1) {
    let best: RecurringCandidate | undefined;
    let bestDiff = Infinity;
    for (const c of candidates) {
      const diff = Math.abs(c.avgAmount - amountHint);
      if (diff < bestDiff) {
        best = c;
        bestDiff = diff;
      }
    }
    candidate = best ?? candidate;
  }
  if (!candidate) return null;
  const existing = (await repos.recurringRules.getAll()).find((r) =>
    sameStream(r.merchantKey ?? "", r.amount, candidate!.merchantKey, candidate!.avgAmount),
  );
  if (existing) return null;
  return createRule(repos, candidate);
}

/** Update a rule's amount after confirming a price increase. */
export async function applyRecurringPriceChange(
  repos: Repositories,
  ruleId: string,
  newAmount: number,
): Promise<void> {
  const rule = await repos.recurringRules.getById(ruleId);
  if (!rule) throw new Error(`applyRecurringPriceChange: unknown rule "${ruleId}"`);
  await repos.recurringRules.put({ ...rule, amount: newAmount, updatedAt: nowIso() });
}

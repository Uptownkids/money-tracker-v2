/**
 * Today's Moves: at most 3 actions that genuinely matter today.
 *
 * Priority (lower number = higher):
 *   1. overdue bills
 *   2. payday run, if today is payday
 *   3. bills due within their reminder window, not on auto-pay
 *   4. pending transactions older than 5 days
 *   5. IOUs older than 14 days
 *   6. unused subscriptions renewing within 7 days
 *   7. goals whose target date has passed ("mark complete?")
 */
import type { DateOnly } from "../dates/dateOnly.js";
import { addDays, compareDateOnly, diffDays } from "../dates/dateOnly.js";
import type { MinorUnits } from "../money/money.js";
import { decimalsOf } from "../money/currency.js";
import type { RecurringRule } from "../entities/recurringRule.js";
import type { Split } from "../entities/split.js";
import type { Transaction } from "../entities/transaction.js";
import type { Goal } from "../entities/goal.js";
import type { ProjectedOccurrence } from "./projection.js";

export type MoveKind =
  | "overdue-bill"
  | "payday-run"
  | "bill-due-soon"
  | "stale-pending"
  | "old-iou"
  | "unused-subscription"
  | "goal-past-due";

export interface TodaysMove {
  id: string;
  kind: MoveKind;
  priority: number; // 1 = highest
  title: string;
  amount?: MinorUnits;
  relatedId: string; // rule, transaction, split, or run id
  actions: Array<"mark-paid" | "snooze" | "open">;
}

export interface MovesContext {
  today: DateOnly;
  isPaydayToday: boolean;
  paydayRunCompleted: boolean;
  /** Generated Scheduled bill rows (and scheduled payday rows). */
  scheduledBills: Transaction[];
  /** Projected bill/subscription occurrences (for due-soon / overdue). */
  projectedBills: ProjectedOccurrence[];
  rules: RecurringRule[];
  pendingTransactions: Transaction[];
  splits: Split[];
  /** All goals (the ranker filters for past-due, uncompleted ones). */
  goals: Goal[];
  /**
   * Snoozed moves, loaded by the caller (e.g. dashboard) from the
   * snoozedMoves table. A move is hidden while
   * `snoozedUntil >= today`.
   */
  snoozed?: ReadonlyMap<string, DateOnly>;
}

function formatMoney(amount: MinorUnits, currency: string): string {
  const d = decimalsOf(currency);
  const major = (amount / 10 ** d).toFixed(d);
  const symbols: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };
  return `${symbols[currency] ?? `${currency} `}${major}`;
}

export function rankTodaysMoves(ctx: MovesContext): TodaysMove[] {
  const { today } = ctx;
  const moves: TodaysMove[] = [];
  const seen = new Set<string>(); // dedupe bill occurrences

  const ruleById = new Map(ctx.rules.map((r) => [r.id, r]));

  // Merge scheduled rows with projections so an overdue bill that has not
  // been generated yet still shows, without double-listing.
  const billCandidates: Array<{
    key: string;
    name: string;
    amount: MinorUnits;
    currency: string;
    date: DateOnly;
    ruleId?: string;
    autoPay: boolean;
    reminderOffsetDays: number;
  }> = [];
  for (const p of ctx.projectedBills) {
    if (p.kind === "Income") continue;
    const rule = ruleById.get(p.ruleId);
    billCandidates.push({
      key: `p:${p.ruleId}:${p.occurrenceDate}`,
      name: rule?.name ?? p.ruleId,
      amount: p.amount,
      currency: p.currency,
      date: p.date,
      ruleId: p.ruleId,
      autoPay: rule?.autoPay ?? false,
      reminderOffsetDays: rule?.reminderOffsetDays ?? 3,
    });
  }
  for (const t of ctx.scheduledBills) {
    if (t.status !== "Scheduled" || t.type === "Income") continue;
    const key =
      t.recurringRuleId && t.occurrenceDate ? `p:${t.recurringRuleId}:${t.occurrenceDate}` : `t:${t.id}`;
    const rule = t.recurringRuleId ? ruleById.get(t.recurringRuleId) : undefined;
    billCandidates.push({
      key,
      name: t.payee || rule?.name || "Bill",
      amount: t.fx ? t.fx.baseAmount : t.amount,
      currency: t.currency,
      date: t.date,
      ruleId: t.recurringRuleId,
      autoPay: rule?.autoPay ?? false,
      reminderOffsetDays: rule?.reminderOffsetDays ?? 3,
    });
  }

  for (const b of billCandidates) {
    if (seen.has(b.key)) continue;
    seen.add(b.key);
    const daysUntil = diffDays(today, b.date);
    if (daysUntil < 0) {
      moves.push({
        id: `move:${b.key}`,
        kind: "overdue-bill",
        priority: 1,
        title: `Pay ${b.name} ${formatMoney(b.amount, b.currency)}, it's overdue`,
        amount: b.amount,
        relatedId: b.ruleId ?? b.key,
        actions: ["mark-paid", "snooze", "open"],
      });
    } else if (!b.autoPay && daysUntil <= b.reminderOffsetDays) {
      moves.push({
        id: `move:${b.key}`,
        kind: "bill-due-soon",
        priority: 3,
        title:
          daysUntil === 0
            ? `Pay ${b.name} ${formatMoney(b.amount, b.currency)} today`
            : `Pay ${b.name} ${formatMoney(b.amount, b.currency)} in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`,
        amount: b.amount,
        relatedId: b.ruleId ?? b.key,
        actions: ["mark-paid", "snooze", "open"],
      });
    }
  }

  // 2. payday run
  if (ctx.isPaydayToday && !ctx.paydayRunCompleted) {
    moves.push({
      id: "move:payday-run",
      kind: "payday-run",
      priority: 2,
      title: "Run today's payday checklist",
      relatedId: "payday-run",
      actions: ["open"],
    });
  }

  // 4. stale pending transactions (> 5 days old)
  const staleCutoff = addDays(today, -5);
  for (const t of ctx.pendingTransactions) {
    if (t.status !== "Pending") continue;
    if (compareDateOnly(t.date, staleCutoff) >= 0) continue;
    moves.push({
      id: `move:stale:${t.id}`,
      kind: "stale-pending",
      priority: 4,
      title: `Confirm ${t.payee || "transaction"} ${formatMoney(t.fx ? t.fx.baseAmount : t.amount, t.currency)}`,
      amount: t.fx ? t.fx.baseAmount : t.amount,
      relatedId: t.id,
      actions: ["mark-paid", "open"],
    });
  }

  // 5. old IOUs (> 14 days)
  const iouCutoff = addDays(today, -14);
  for (const s of ctx.splits) {
    if (s.settled) continue;
    if (s.createdAt.slice(0, 10) >= iouCutoff) continue;
    moves.push({
      id: `move:iou:${s.id}`,
      kind: "old-iou",
      priority: 5,
      title:
        s.direction === "TheyOweMe"
          ? `Remind ${s.person} about ${formatMoney(s.amount, s.currency)}`
          : `Pay back ${s.person} ${formatMoney(s.amount, s.currency)}`,
      amount: s.amount,
      relatedId: s.id,
      actions: ["snooze", "open"],
    });
  }

  // 6. unused subscriptions renewing within 7 days
  const subCutoff = addDays(today, 7);
  for (const p of ctx.projectedBills) {
    if (p.kind !== "Subscription") continue;
    const rule = ruleById.get(p.ruleId);
    if (!rule?.unusedFlag) continue;
    if (compareDateOnly(p.date, today) < 0 || compareDateOnly(p.date, subCutoff) > 0) continue;
    moves.push({
      id: `move:unsub:${p.ruleId}:${p.occurrenceDate}`,
      kind: "unused-subscription",
      priority: 6,
      title: `Cancel ${rule.name}? It renews ${p.date}`,
      amount: p.amount,
      relatedId: p.ruleId,
      actions: ["snooze", "open"],
    });
  }

  // 7. goals whose target date has passed — nudge to mark complete.
  // Completed goals never appear; snoozing hides one until tomorrow.
  for (const g of ctx.goals) {
    if (g.completed) continue;
    if (!g.targetDate) continue;
    if (compareDateOnly(g.targetDate, today) >= 0) continue;
    moves.push({
      id: `move:goal-due:${g.id}`,
      kind: "goal-past-due",
      priority: 7,
      title: `${g.name}: mark complete?`,
      relatedId: g.id,
      actions: ["snooze", "open"],
    });
  }

  moves.sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1));
  // Snoozed moves are filtered before the cap so a hidden move never
  // consumes one of the 3 slots.
  const visible = ctx.snoozed
    ? moves.filter((m) => {
        const until = ctx.snoozed!.get(m.id);
        return until === undefined || compareDateOnly(until, today) < 0;
      })
    : moves;
  return visible.slice(0, 3);
}

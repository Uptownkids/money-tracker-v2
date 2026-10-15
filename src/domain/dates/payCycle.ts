/**
 * Pay-cycle resolution from the primary payday rule.
 *
 * A pay cycle runs from one payday (inclusive) through the day before the
 * next payday (inclusive). daysLeft = nextPayday - today.
 */
import {
  DateOnly,
  WeekendShift,
  addDays,
  addMonthsClamped,
  addYearsClamped,
  assertDateOnly,
  clampDayOfMonth,
  compareDateOnly,
  dayOfMonth,
  diffDays,
  monthOf,
  shiftWeekend,
  yearOf,
} from "./dateOnly.js";
import type { RecurringRule } from "../entities/recurringRule.js";

export interface PayCycle {
  cycleStart: DateOnly; // most recent payday on or before today
  cycleEnd: DateOnly; // day before nextPayday
  nextPayday: DateOnly; // first payday strictly after today
  daysLeft: number; // today through cycleEnd, inclusive (min 1)
}

/** Raw payday dates for a rule inside [from, to], before weekend shift. */
function rawPaydays(rule: RecurringRule, from: DateOnly, to: DateOnly): DateOnly[] {
  const out: DateOnly[] = [];
  const push = (d: DateOnly) => {
    if (compareDateOnly(d, from) >= 0 && compareDateOnly(d, to) <= 0) out.push(d);
  };
  switch (rule.frequency) {
    case "semi-monthly": {
      const days = [...new Set(rule.daysOfMonth ?? [1, 15])].sort((a, b) => a - b);
      let y = yearOf(from);
      let m = monthOf(from);
      // cover the window month by month
      for (;;) {
        for (const day of days) push(clampDayOfMonth(y, m, day));
        if (y === yearOf(to) && m === monthOf(to)) break;
        m += 1;
        if (m > 12) {
          m = 1;
          y += 1;
        }
        if (y > yearOf(to) + 1) break;
      }
      break;
    }
    case "monthly": {
      const dom = dayOfMonth(rule.nextDueDate);
      let y = yearOf(from);
      let m = monthOf(from);
      for (;;) {
        push(clampDayOfMonth(y, m, dom));
        if (y === yearOf(to) && m === monthOf(to)) break;
        m += 1;
        if (m > 12) {
          m = 1;
          y += 1;
        }
        if (y > yearOf(to) + 1) break;
      }
      break;
    }
    case "annual": {
      let d = rule.nextDueDate;
      // rewind to at-or-before from
      while (compareDateOnly(addYearsClamped(d, 1), from) <= 0) d = addYearsClamped(d, 1);
      while (compareDateOnly(d, from) >= 0) {
        const prev = addYearsClamped(d, -1);
        if (compareDateOnly(prev, from) < 0) break;
        d = prev;
      }
      for (;;) {
        push(d);
        const next = addYearsClamped(d, 1);
        if (compareDateOnly(next, to) > 0 || compareDateOnly(d, to) > 0) break;
        d = next;
      }
      break;
    }
    case "weekly":
    case "biweekly":
    case "custom": {
      const step =
        rule.frequency === "weekly" ? 7 : rule.frequency === "biweekly" ? 14 : (rule.customIntervalDays ?? 0);
      if (step <= 0) throw new RangeError(`payCycle: custom frequency needs customIntervalDays > 0`);
      const anchor = rule.nextDueDate;
      const kMin = Math.ceil(diffDays(anchor, from) / step);
      const kMax = Math.floor(diffDays(anchor, to) / step);
      for (let k = kMin; k <= kMax; k++) push(addDays(anchor, k * step));
      break;
    }
  }
  return out;
}

/** Payday dates for a rule inside [from, to], with weekend shift applied. */
export function enumeratePaydays(rule: RecurringRule, from: DateOnly, to: DateOnly): DateOnly[] {
  assertDateOnly(from, "enumeratePaydays(from)");
  assertDateOnly(to, "enumeratePaydays(to)");
  const shift: WeekendShift = rule.weekendShift ?? "none";
  const dates = rawPaydays(rule, from, to).map((d) => shiftWeekend(d, shift));
  dates.sort(compareDateOnly);
  return [...new Set(dates)];
}

/** Number of paydays in (fromExclusive, toInclusive]. */
export function countPaydays(fromExclusive: DateOnly, toInclusive: DateOnly, rule: RecurringRule): number {
  return enumeratePaydays(rule, addDays(fromExclusive, 1), toInclusive).length;
}

/**
 * Resolve the pay cycle containing `today` from the primary payday rule.
 * Returns null when there is no primary payday rule (caller falls back to
 * the 30-day rolling window).
 */
export function resolvePayCycle(today: DateOnly, primaryRule: RecurringRule | null): PayCycle | null {
  assertDateOnly(today, "resolvePayCycle(today)");
  if (!primaryRule) return null;
  const from = addDays(today, -370);
  const to = addDays(today, 370);
  const paydays = enumeratePaydays(primaryRule, from, to);
  let cycleStart: DateOnly | null = null;
  let nextPayday: DateOnly | null = null;
  for (const p of paydays) {
    if (compareDateOnly(p, today) <= 0) cycleStart = p;
    else {
      nextPayday = p;
      break;
    }
  }
  if (!cycleStart || !nextPayday) {
    throw new RangeError("resolvePayCycle: could not bracket today with paydays");
  }
  const daysLeft = Math.max(1, diffDays(today, nextPayday));
  return { cycleStart, cycleEnd: addDays(nextPayday, -1), nextPayday, daysLeft };
}

/**
 * Calendar-date handling with no time zones.
 *
 * A DateOnly is always "YYYY-MM-DD". All arithmetic uses UTC calendar
 * fields exclusively (Date.UTC and getUTC*) so local time-zone offsets can
 * never shift a date. date-fns is intentionally NOT used here: its
 * date functions read local-time fields, which breaks every date by one
 * day in time zones behind UTC (e.g. America/New_York).
 */
export type DateOnly = string; // "YYYY-MM-DD"

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateOnly(s: string): s is DateOnly {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

export function assertDateOnly(s: string, what = "date"): asserts s is DateOnly {
  if (!isDateOnly(s)) throw new RangeError(`${what} is not a valid YYYY-MM-DD date: ${s}`);
}

function toUtcDate(d: DateOnly): Date {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, day));
}

function fromUtcDate(dt: Date): DateOnly {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Device's current calendar date (local wall-clock date, no conversion). */
export function todayLocal(): DateOnly {
  const n = new Date();
  const m = String(n.getMonth() + 1).padStart(2, "0");
  const d = String(n.getDate()).padStart(2, "0");
  return `${n.getFullYear()}-${m}-${d}`;
}

export function addDays(d: DateOnly, n: number): DateOnly {
  assertDateOnly(d, "addDays");
  if (!Number.isInteger(n)) throw new TypeError("addDays: n must be an integer");
  const dt = new Date(Date.UTC(yearOf(d), monthOf(d) - 1, dayOfMonth(d) + n));
  return fromUtcDate(dt);
}

/** Whole days from a to b (b - a). Negative when b is earlier. */
export function diffDays(a: DateOnly, b: DateOnly): number {
  assertDateOnly(a, "diffDays(a)");
  assertDateOnly(b, "diffDays(b)");
  const msA = Date.UTC(yearOf(a), monthOf(a) - 1, dayOfMonth(a));
  const msB = Date.UTC(yearOf(b), monthOf(b) - 1, dayOfMonth(b));
  return Math.round((msB - msA) / 86_400_000);
}

export function compareDateOnly(a: DateOnly, b: DateOnly): number {
  assertDateOnly(a, "compareDateOnly(a)");
  assertDateOnly(b, "compareDateOnly(b)");
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDateOnly(a: DateOnly, b: DateOnly): DateOnly {
  return compareDateOnly(a, b) <= 0 ? a : b;
}

export function maxDateOnly(a: DateOnly, b: DateOnly): DateOnly {
  return compareDateOnly(a, b) >= 0 ? a : b;
}

export function yearOf(d: DateOnly): number {
  return Number(d.slice(0, 4));
}

export function monthOf(d: DateOnly): number {
  return Number(d.slice(5, 7));
}

export function dayOfMonth(d: DateOnly): number {
  return Number(d.slice(8, 10));
}

export function daysInMonth(year: number, month: number): number {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`daysInMonth: invalid year/month ${year}/${month}`);
  }
  // Day 0 of month `month` (1-indexed -> 0-based next month) is the last
  // day of the target month. getUTCDate reads it in UTC, never local time.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** First day of the date's month. */
export function startOfMonth(d: DateOnly): DateOnly {
  assertDateOnly(d, "startOfMonth");
  return `${d.slice(0, 7)}-01`;
}

/** Last day of the date's month. */
export function endOfMonth(d: DateOnly): DateOnly {
  assertDateOnly(d, "endOfMonth");
  const y = yearOf(d);
  const m = monthOf(d);
  return `${d.slice(0, 7)}-${String(daysInMonth(y, m)).padStart(2, "0")}`;
}

/**
 * Add months, clamping the day to the target month's length.
 * addMonthsClamped("2026-01-31", 1) -> "2026-02-28".
 */
export function addMonthsClamped(d: DateOnly, n: number): DateOnly {
  assertDateOnly(d, "addMonthsClamped");
  if (!Number.isInteger(n)) throw new TypeError("addMonthsClamped: n must be an integer");
  let y = yearOf(d);
  let m = monthOf(d) + n;
  y += Math.floor((m - 1) / 12);
  m = ((m - 1) % 12 + 12) % 12 + 1;
  const day = Math.min(dayOfMonth(d), daysInMonth(y, m));
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Add years, clamping Feb 29 to Feb 28 in non-leap years. */
export function addYearsClamped(d: DateOnly, n: number): DateOnly {
  return addMonthsClamped(d, n * 12);
}

export function isWeekend(d: DateOnly): boolean {
  assertDateOnly(d, "isWeekend");
  const dow = toUtcDate(d).getUTCDay();
  return dow === 0 || dow === 6;
}

export type WeekendShift = "previous-business-day" | "next-business-day" | "none";

/** Shift a Sat/Sun date per the rule's weekend-shift setting. */
export function shiftWeekend(d: DateOnly, shift: WeekendShift): DateOnly {
  assertDateOnly(d, "shiftWeekend");
  if (shift === "none" || !isWeekend(d)) return d;
  // toUtcDate(d).getUTCDay(): 0 = Sunday, 6 = Saturday
  const dow = toUtcDate(d).getUTCDay();
  if (shift === "previous-business-day") {
    return addDays(d, dow === 6 ? -1 : -2); // Sat -> Fri, Sun -> Fri
  }
  return addDays(d, dow === 6 ? 2 : 1); // Sat -> Mon, Sun -> Mon
}

/** Clamp a day-of-month to a month's length, returning a DateOnly. */
export function clampDayOfMonth(year: number, month: number, day: number): DateOnly {
  const clamped = Math.min(Math.max(1, day), daysInMonth(year, month));
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
}

/**
 * Wells Fargo checking/savings statement PDF parser.
 *
 * The PDF's "Transaction history" table is read from positioned text
 * (pdf.js in the app layer); this module is pure and works on lines of
 * text items with x coordinates. Layout (points, letter page):
 *
 *   Date (x~60) | Check# (x~120) | Description (x~150) |
 *   Deposits/Additions right-aligned x1~434 |
 *   Withdrawals/Subtractions right-aligned x1~502 |
 *   Ending daily balance right-aligned x1~566 (ignored — not a transaction)
 *
 * Descriptions wrap to 2-3 lines; continuation lines carry no date.
 * The table ends at the "Totals" summary row. Dates are M/D; the year
 * comes from the statement date ("August 25, 2026" in the page header):
 * a transaction month after the statement month belongs to the prior
 * year.
 *
 * Output is ParsedBankRow[], the same shape as the CSV parser, so the
 * import engine needs no changes.
 */
import type { DateOnly } from "../dates/dateOnly.js";
import type { MinorUnits } from "../money/money.js";
import { extractStableId } from "./wellsFargoCsv.js";
import type { ParseResult, ParsedBankRow } from "./wellsFargoCsv.js";

/** One positioned text fragment from the PDF. */
export interface PdfTextItem {
  /** Left edge x (points). */
  x: number;
  /** Right edge x1 (points). */
  x1: number;
  /** Baseline y; only relative order matters. */
  y: number;
  text: string;
}

/** One page: lines top-to-bottom, items within a line left-to-right. */
export interface PdfPage {
  lines: PdfTextItem[][];
}

export interface WellsFargoPdfOptions {
  statementYear: number;
  /** 1-12. */
  statementMonth: number;
}

const DATE_X_MAX = 115;
const DESC_X_MIN = 140;
const DEPOSIT_X1_MAX = 460;
const WITHDRAWAL_X1_MAX = 540;

const DATE_RE = /^(\d{1,2})\/(\d{1,2})$/;
const AMOUNT_RE = /^\$?([\d,]+\.\d{2})$/;
const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function parseAmountToMinor(raw: string): MinorUnits | null {
  const m = AMOUNT_RE.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function resolveYear(month: number, statementYear: number, statementMonth: number): number {
  return month > statementMonth ? statementYear - 1 : statementYear;
}

/**
 * Column-header words ("Deposits/", "Additions", …). pdf.js groups text
 * into lines by baseline, so a header word can land on the same visual
 * line as a transaction's continuation text. These words never appear in
 * a real description, so description items matching them are dropped.
 */
const HEADER_WORDS = new Set([
  "date", "check", "number", "description",
  "deposits/", "additions", "withdrawals/", "subtractions",
  "ending", "daily", "balance",
]);

function isHeaderWord(text: string): boolean {
  return HEADER_WORDS.has(text.trim().toLowerCase());
}

function descriptionItems(line: PdfTextItem[]): PdfTextItem[] {
  return line.filter(
    (i) =>
      i.x >= DESC_X_MIN &&
      i.x1 <= DEPOSIT_X1_MAX &&
      parseAmountToMinor(i.text) === null &&
      !isHeaderWord(i.text),
  );
}

/**
 * Lines that are part of the table chrome, not transactions: the
 * "Transaction history" title (repeated on every page), the column
 * header row, and page footers ("August 25, 2026 Page 12 of 16").
 * Without this, a page break mid-table would glue header words onto
 * the pending transaction's description.
 */
function isTableChrome(text: string): boolean {
  if (/transaction history/i.test(text)) return true;
  if (/description/i.test(text) && /(deposits|withdrawals|additions|subtractions)/i.test(text)) {
    return true;
  }
  if (/\bpage\s+\d+\s+of\s+\d+/i.test(text)) return true;
  return false;
}

function toDateOnly(month: number, day: number, year: number): DateOnly | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` as DateOnly;
}

/**
 * Find "Month DD, YYYY" in the page headers (e.g. "August 25, 2026").
 * Returns null when the statement date can't be determined.
 */
export function detectStatementDate(pages: PdfPage[]): { year: number; month: number } | null {
  const re = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/i;
  for (const page of pages) {
    for (const line of page.lines) {
      const text = line.map((i) => i.text).join(" ");
      const m = re.exec(text);
      if (m) {
        return { year: Number(m[3]), month: MONTHS[m[1]!.toLowerCase()]! };
      }
    }
  }
  return null;
}

interface PendingTx {
  date: DateOnly;
  descriptionParts: string[];
  checkNumber: string | null;
  amountMinor: MinorUnits | null;
  /** True = deposit (money in), false = withdrawal. */
  isDeposit: boolean;
  lineNumber: number;
}

function flush(
  pending: PendingTx | null,
  rows: ParsedBankRow[],
  errors: string[],
): PendingTx | null {
  if (!pending) return null;
  if (pending.amountMinor === null) {
    errors.push(`Line ${pending.lineNumber}: no amount found, skipped.`);
    return null;
  }
  const description = [
    ...(pending.checkNumber ? [`Check ${pending.checkNumber}`] : []),
    ...pending.descriptionParts,
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const row: ParsedBankRow = {
    date: pending.date,
    amountMinor: (pending.isDeposit ? pending.amountMinor : -pending.amountMinor) as MinorUnits,
    description,
    lineNumber: pending.lineNumber,
  };
  const stableId = extractStableId(description);
  if (stableId) row.stableId = stableId;
  rows.push(row);
  return null;
}

/**
 * Parse Wells Fargo statement PDF pages into bank rows. Pure function;
 * the app layer extracts positioned text with pdf.js.
 */
export function parseWellsFargoPdf(
  pages: PdfPage[],
  opts: WellsFargoPdfOptions,
): ParseResult {
  const rows: ParsedBankRow[] = [];
  const errors: string[] = [];
  let inTable = false;
  let pending: PendingTx | null = null;
  let lineNumber = 0;

  // One stream: a transaction's continuation lines can span a page break.
  const allLines = pages.flatMap((p) => p.lines);

  for (const line of allLines) {
    lineNumber += 1;
    const text = line.map((i) => i.text).join(" ").trim();

    if (!inTable) {
      if (/transaction history/i.test(text)) inTable = true;
      continue;
    }

    // End of table: the Totals summary row (not a transaction).
    if (/^totals\b/i.test(text)) {
      pending = flush(pending, rows, errors);
      break;
    }

    // Table chrome repeated on every page — never a transaction.
    if (isTableChrome(text)) continue;

    const dateItem = line.find((i) => i.x < DATE_X_MAX && DATE_RE.test(i.text.trim()));
    const dateMatch = dateItem ? DATE_RE.exec(dateItem.text.trim()) : null;

    if (dateMatch) {
      pending = flush(pending, rows, errors);
      const month = Number(dateMatch[1]);
      const day = Number(dateMatch[2]);
      const year = resolveYear(month, opts.statementYear, opts.statementMonth);
      const date = toDateOnly(month, day, year);
      if (!date) {
        errors.push(`Line ${lineNumber}: bad date "${dateItem!.text.trim()}", skipped.`);
        continue;
      }
      const checkItem = line.find((i) => i.x >= DATE_X_MAX && i.x < DESC_X_MIN && /^\d+$/.test(i.text.trim()));

      // Rightmost amount-like token; its column decides the direction.
      // The ending-daily-balance column (x1 > 540) is never a transaction.
      let amountMinor: MinorUnits | null = null;
      let isDeposit = false;
      for (const item of line) {
        const amt = parseAmountToMinor(item.text);
        if (amt === null) continue;
        if (item.x1 <= DEPOSIT_X1_MAX) {
          amountMinor = amt;
          isDeposit = true;
        } else if (item.x1 <= WITHDRAWAL_X1_MAX) {
          amountMinor = amt;
          isDeposit = false;
        }
        // x1 beyond that: ending daily balance — ignored.
      }

      const descriptionParts = descriptionItems(line).map((i) => i.text);

      pending = {
        date,
        descriptionParts,
        checkNumber: checkItem ? checkItem.text.trim() : null,
        amountMinor,
        isDeposit,
        lineNumber,
      };
    } else if (pending) {
      // Continuation line: description text only (no date, no amount).
      const extra = descriptionItems(line).map((i) => i.text);
      // Guard: a stray amount-like token on a continuation line that sits
      // in an amount column belongs to the pending transaction.
      if (extra.length === 0) {
        for (const item of line) {
          const amt = parseAmountToMinor(item.text);
          if (amt === null || pending.amountMinor !== null) continue;
          if (item.x1 <= DEPOSIT_X1_MAX) {
            pending.amountMinor = amt;
            pending.isDeposit = true;
          } else if (item.x1 <= WITHDRAWAL_X1_MAX) {
            pending.amountMinor = amt;
            pending.isDeposit = false;
          }
        }
      }
      pending.descriptionParts.push(...extra);
    }
    // Lines outside a transaction (headers, footers) are ignored.
  }
  flush(pending, rows, errors);

  return { rows, errors };
}

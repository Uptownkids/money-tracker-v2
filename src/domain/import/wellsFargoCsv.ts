/**
 * Wells Fargo CSV import parser (Phase A: fully local, no network).
 *
 * The parser is driven by a column map so it can be adjusted if a real
 * download differs from the assumed format. Assumptions are documented
 * on DEFAULT_COLUMN_MAP and in the morning report — Malike should
 * compare expected-csv-sample.csv against his real download.
 *
 * Money rules: amounts are parsed to integer minor units; the sign
 * convention is configurable per account mapping (see AmountSign).
 * The parser never decides transaction types — it returns signed
 * amounts and lets the importer/matching engine classify.
 */
import type { DateOnly } from "../dates/dateOnly.js";
import { assertDateOnly } from "../dates/dateOnly.js";
import type { MinorUnits } from "../money/money.js";

/** One parsed row from a bank CSV file. */
export interface ParsedBankRow {
  /** Posting date as DateOnly (calendar date, no timezone). */
  date: DateOnly;
  /** Signed amount in minor units. Positive = money INTO this account. */
  amountMinor: MinorUnits;
  /** Raw description exactly as the bank wrote it. */
  description: string;
  /** Stable bank transaction id when the description carries one
   * (e.g. a Zelle Ref #). Used for duplicate checking. */
  stableId?: string;
  /** 1-based line number in the source file (for error messages). */
  lineNumber: number;
}

/**
 * Which column holds what. Indices are 0-based. Adjust when a real
 * download differs — everything else keys off this map.
 */
export interface WellsFargoColumnMap {
  date: number;
  amount: number;
  description: number;
  /** Date format in the file. Currently only "MM/DD/YYYY" is supported. */
  dateFormat: "MM/DD/YYYY";
}

/**
 * Assumed standard Wells Fargo "Download Activity" CSV layout:
 *   Date, Amount, *, *, Description
 * with a possible header row. Amounts are signed decimal strings
 * (e.g. -8.76 for money out, 1500.00 for money in). Parenthesised
 * negatives like (8.76) are also accepted.
 */
export const DEFAULT_COLUMN_MAP: WellsFargoColumnMap = {
  date: 0,
  amount: 1,
  description: 4,
  dateFormat: "MM/DD/YYYY",
};

/**
 * How to read the file's amount sign for one account mapping.
 * - "negative-is-outflow": -8.76 means money left the account
 *   (standard for Wells Fargo checking/savings downloads).
 * - "negative-is-inflow": -8.76 means money came IN (some card
 *   exports invert the sign: purchases positive, payments negative).
 * Malike: if your credit-card download reads backwards, flip this
 * for that account mapping — amounts will be wrong otherwise.
 */
export type AmountSignConvention = "negative-is-outflow" | "negative-is-inflow";

export interface ParseOptions {
  columnMap?: WellsFargoColumnMap;
  sign?: AmountSignConvention;
  /** Skip the first line when it looks like a header row. Default true. */
  skipHeader?: boolean;
}

export interface ParseResult {
  rows: ParsedBankRow[];
  /** Human-readable problems, with line numbers. Empty when clean. */
  errors: string[];
}

/** Split one CSV line into fields, honouring double-quoted fields. */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields.map((f) => f.trim());
}

function looksLikeHeader(fields: string[]): boolean {
  const joined = fields.join(" ").toLowerCase();
  return /date/.test(joined) && /amount|description/.test(joined);
}

function parseDateField(raw: string, lineNumber: number): DateOnly | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const [, ms, ds, yyyy] = m;
  if (!ms || !ds || !yyyy) return null;
  const mm = ms.padStart(2, "0");
  const dd = ds.padStart(2, "0");
  const iso = `${yyyy}-${mm}-${dd}`;
  try {
    assertDateOnly(iso, `CSV line ${lineNumber}`);
    return iso;
  } catch {
    return null;
  }
}

/**
 * Parse a decimal amount string to integer minor units, preserving sign.
 * Accepts "$1,234.56", "-8.76", "(8.76)" (parenthesised negative).
 * Returns null when the string is not a valid amount.
 */
export function parseAmountToMinor(raw: string): MinorUnits | null {
  let s = raw.trim().replace(/[$,\s]/g, "");
  if (s === "") return null;
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.replace(/^-/, "").split(".");
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) return null;
  const signed = s.startsWith("-") ? -minor : minor;
  return (negative ? -Math.abs(signed) : signed) as MinorUnits;
}

/** Zelle Ref # doubles as a stable transaction id, e.g. "REF # 123456". */
const ZELLE_REF_RE = /REF\s*#\s*([A-Z0-9-]+)/i;

export function extractStableId(description: string): string | undefined {
  const m = ZELLE_REF_RE.exec(description);
  const ref = m?.[1];
  return ref ? `zelle:${ref.toUpperCase()}` : undefined;
}

/**
 * Parse a Wells Fargo CSV export into signed bank rows.
 * Never throws on bad lines — problems are collected in `errors`.
 */
export function parseWellsFargoCsv(text: string, options: ParseOptions = {}): ParseResult {
  const map = options.columnMap ?? DEFAULT_COLUMN_MAP;
  const sign: AmountSignConvention = options.sign ?? "negative-is-outflow";
  const skipHeader = options.skipHeader ?? true;
  const rows: ParsedBankRow[] = [];
  const errors: string[] = [];

  const lines = text.split(/\r?\n/);
  const maxCol = Math.max(map.date, map.amount, map.description);
  lines.forEach((rawLine, idx) => {
    const lineNumber = idx + 1;
    if (rawLine.trim() === "") return;
    const fields = splitCsvLine(rawLine);
    if (idx === 0 && skipHeader && looksLikeHeader(fields)) return;
    if (fields.length <= maxCol) {
      errors.push(`Line ${lineNumber}: expected at least ${maxCol + 1} columns, found ${fields.length}`);
      return;
    }
    const dateRaw = fields[map.date] as string;
    const amountRaw = fields[map.amount] as string;
    const description = fields[map.description] as string;
    const date = parseDateField(dateRaw, lineNumber);
    if (!date) {
      errors.push(`Line ${lineNumber}: could not parse date "${dateRaw}"`);
      return;
    }
    const amount = parseAmountToMinor(amountRaw);
    if (amount === null) {
      errors.push(`Line ${lineNumber}: could not parse amount "${amountRaw}"`);
      return;
    }
    if (!description) {
      errors.push(`Line ${lineNumber}: empty description`);
      return;
    }
    const signed = (sign === "negative-is-outflow" ? amount : -amount) as MinorUnits;
    if (signed === 0) {
      errors.push(`Line ${lineNumber}: zero amount`);
      return;
    }
    rows.push({
      date,
      amountMinor: signed,
      description,
      stableId: extractStableId(description),
      lineNumber,
    });
  });

  return { rows, errors };
}

/**
 * Deep links: one-tap URLs that prefill Quick-Log or propose a balance
 * correction. Pure parsing — no DOM, no database. The App resolves the
 * matched account name to an id and owns every side effect.
 *
 *   ?add=expense&amount=12.50&payee=Chipotle&account=checking&date=2026-10-15
 *   ?adjust=checking&balance=30
 *
 * Any validation failure yields { ok: false, error } with a human-readable
 * reason. A successful parse is all-or-nothing: there is never a partial
 * intent. Amounts stay as validated decimal strings here; they are parsed
 * into minor units per the account's currency at the point of use (the
 * Quick-Log sheet's normal save path, or parseBalanceToMinor below).
 */
import { isDateOnly, type DateOnly } from "../domain/dates/dateOnly.js";
import { decimalsOf } from "../domain/money/currency.js";
import type { MinorUnits } from "../domain/money/money.js";
import { toStoredBalance, type AccountType } from "../domain/entities/account.js";

export type DeepLinkEntryType = "Expense" | "Income";

export interface AddIntent {
  kind: "add";
  entryType: DeepLinkEntryType;
  /** Validated decimal string, e.g. "12.50". Parsed per-currency at save. */
  amountText: string;
  payee: string;
  /** Account name as written in the link; the App resolves it to an id. */
  accountName: string;
  date: DateOnly;
}

export interface AdjustIntent {
  kind: "adjust";
  accountName: string;
  /**
   * Validated signed decimal string, e.g. "30" or "-15.50" (negative
   * allowed for asset accounts — overdrawn. Card/loan negatives are
   * rejected by decideAdjust with a proper message).
   */
  balanceText: string;
}

export type DeepLinkIntent = AddIntent | AdjustIntent;

export type DeepLinkParseResult =
  | { ok: true; intent: DeepLinkIntent | null }
  | { ok: false; error: string };

const fail = (error: string): DeepLinkParseResult => ({ ok: false, error });

/** Plain decimal dollars: "12", "12.5", "12.50". No $, commas, or signs. */
const DECIMAL_RE = /^\d+(\.\d{1,9})?$/;
/**
 * Sanity cap so a parsed value can never overflow minor-unit math:
 * 1e12 dollars is 1e14 cents, well under Number.MAX_SAFE_INTEGER.
 */
const MAX_MAJOR = 1e12;

function isDecimalNumber(text: string): boolean {
  if (!DECIMAL_RE.test(text)) return false;
  const n = Number(text);
  return Number.isFinite(n) && n <= MAX_MAJOR;
}

/** Decimal string that parses to a finite number strictly greater than 0. */
function isPositiveDecimal(text: string): boolean {
  return isDecimalNumber(text) && Number(text) > 0;
}

/** Signed decimal: optional leading "-" (asset accounts can be overdrawn). */
function isSignedDecimal(text: string): boolean {
  const t = text.startsWith("-") ? text.slice(1) : text;
  return isDecimalNumber(t);
}

export type AccountMatch = { ok: true; name: string } | { ok: false; error: string };

/**
 * Match a link's account parameter against real account names,
 * case-insensitive. Zero matches or more than one match is an error —
 * the link never guesses. Also used by the inbox approval flow.
 */
export function matchAccountName(
  accountNames: readonly string[],
  raw: string,
): AccountMatch {
  const needle = raw.trim().toLowerCase();
  const matches = accountNames.filter(
    (n) => n.trim().toLowerCase() === needle,
  );
  if (matches.length === 0) {
    return { ok: false, error: `account "${raw.trim()}" not found` };
  }
  if (matches.length > 1) {
    const list = matches.map((m) => `"${m}"`).join(", ");
    return {
      ok: false,
      error: `account "${raw.trim()}" matches more than one account (${list}) — use the full name`,
    };
  }
  const name = matches[0];
  // Length is exactly 1, so this is unreachable; kept for the type checker.
  if (name === undefined) return { ok: false, error: `account "${raw.trim()}" not found` };
  return { ok: true, name };
}

const ADD_PARAMS = new Set(["add", "amount", "payee", "account", "date"]);
const ADJUST_PARAMS = new Set(["adjust", "balance"]);

function unknownParam(params: URLSearchParams, allowed: Set<string>): string | null {
  for (const key of params.keys()) {
    if (!allowed.has(key)) return key;
  }
  return null;
}

function parseAdd(
  params: URLSearchParams,
  accountNames: readonly string[],
  today: DateOnly,
): DeepLinkParseResult {
  const bad = unknownParam(params, ADD_PARAMS);
  if (bad !== null) return fail(`unknown parameter "${bad}"`);

  const rawType = (params.get("add") ?? "").trim().toLowerCase();
  if (rawType === "transfer") {
    return fail("links can't create transfers yet — log those in the app");
  }
  if (rawType !== "expense" && rawType !== "income") {
    return fail(`unknown entry type "${params.get("add") ?? ""}" — use expense or income`);
  }
  const entryType: DeepLinkEntryType = rawType === "expense" ? "Expense" : "Income";

  const amountRaw = params.get("amount");
  if (amountRaw === null) return fail("missing amount");
  const amountText = amountRaw.trim();
  if (!isPositiveDecimal(amountText)) {
    return fail(`amount "${amountRaw}" isn't a valid positive number`);
  }

  const payeeRaw = params.get("payee");
  if (payeeRaw === null || payeeRaw.trim() === "") {
    return fail("payee is missing or empty");
  }

  const accountRaw = params.get("account");
  if (accountRaw === null || accountRaw.trim() === "") {
    return fail("account is missing or empty");
  }
  const matched = matchAccountName(accountNames, accountRaw);
  if (!matched.ok) return fail(matched.error);

  let date: DateOnly = today;
  const dateRaw = params.get("date");
  if (dateRaw !== null) {
    const d = dateRaw.trim();
    if (!isDateOnly(d)) {
      return fail(`date "${dateRaw}" isn't valid — use YYYY-MM-DD`);
    }
    date = d;
  }

  return {
    ok: true,
    intent: {
      kind: "add",
      entryType,
      amountText,
      payee: payeeRaw.trim(),
      accountName: matched.name,
      date,
    },
  };
}

function parseAdjust(
  params: URLSearchParams,
  accountNames: readonly string[],
): DeepLinkParseResult {
  const bad = unknownParam(params, ADJUST_PARAMS);
  if (bad !== null) return fail(`unknown parameter "${bad}"`);

  const adjustRaw = params.get("adjust") ?? "";
  if (adjustRaw.trim() === "") return fail("account is missing or empty");
  const matched = matchAccountName(accountNames, adjustRaw);
  if (!matched.ok) return fail(matched.error);

  const balanceRaw = params.get("balance");
  if (balanceRaw === null) return fail("missing balance");
  const balanceText = balanceRaw.trim();
  // Signed decimal allowed here; decideAdjust rejects negatives for
  // card/loan accounts ("enter the amount owed as a positive number").
  if (!isSignedDecimal(balanceText)) {
    return fail(`balance "${balanceRaw}" isn't a valid number`);
  }

  return {
    ok: true,
    intent: { kind: "adjust", accountName: matched.name, balanceText },
  };
}

/**
 * Parse a deep-link query string (the part after "?", with or without the
 * leading "?"). Empty string means "no link" — { ok: true, intent: null }.
 * accountNames are the user's real (non-archived) account names; today is
 * the default date when the link omits one.
 */
export function parseDeepLink(
  search: string,
  accountNames: readonly string[],
  today: DateOnly,
): DeepLinkParseResult {
  const params = new URLSearchParams(search);
  if ([...params.keys()].length === 0) return { ok: true, intent: null };

  const hasAdd = params.has("add");
  const hasAdjust = params.has("adjust");
  if (hasAdd && hasAdjust) {
    return fail("can't combine add and adjust in one link");
  }
  if (!hasAdd && !hasAdjust) {
    return fail("not a Money Tracker link — expected ?add=... or ?adjust=...");
  }
  return hasAdd
    ? parseAdd(params, accountNames, today)
    : parseAdjust(params, accountNames);
}

export type AdjustDecision =
  | { kind: "match" }
  | { kind: "unlogged-spending"; differenceMinor: MinorUnits }
  | { kind: "money-appeared"; differenceMinor: MinorUnits }
  | { kind: "correction"; differenceMinor: MinorUnits }
  | { kind: "invalid"; error: string };

export interface DecideAdjustInput {
  accountType: AccountType;
  /** Stored balance (negative for card/loan debt). */
  appBalanceMinor: MinorUnits;
  /** Raw user input, e.g. "30" or "-15.50" for an overdrawn asset account. */
  statedText: string;
  currency: string;
}

/**
 * Balance-correction math with account-type semantics.
 *
 * - Asset accounts (Cash/Checking/...): the stated text is the balance as
 *   the user sees it; a leading "-" is allowed (overdrawn). diff < 0
 *   (money missing) -> unlogged-spending; diff > 0 (money appeared) ->
 *   money-appeared, which the dialog resolves into a Refund, an IOU
 *   repayment, forgotten income, or a tagged balance correction — never
 *   an automatic Income.
 * - Card/Loan accounts: the stated text is the amount OWED (>= 0).
 *   Negative input is rejected. diff < 0 (owed went up) ->
 *   unlogged-spending on the card; diff > 0 (owed went down) ->
 *   correction inflow, tagged so it never counts as income.
 *
 * Pure.
 */
export function decideAdjust(input: DecideAdjustInput): AdjustDecision {
  const { accountType, appBalanceMinor, statedText, currency } = input;
  const isLiability = accountType === "CreditCard" || accountType === "Loan";
  const text = statedText.trim();
  if (isLiability && text.startsWith("-")) {
    return { kind: "invalid", error: "enter the amount owed as a positive number" };
  }
  const minor = parseSignedBalanceToMinor(text, currency);
  if (minor === null) {
    return { kind: "invalid", error: `"${text}" isn't a valid amount` };
  }
  const statedStored = isLiability ? toStoredBalance(accountType, minor) : minor;
  const diff = statedStored - appBalanceMinor;
  if (diff === 0) return { kind: "match" };
  if (diff < 0) {
    return { kind: "unlogged-spending", differenceMinor: -diff as MinorUnits };
  }
  return isLiability
    ? { kind: "correction", differenceMinor: diff as MinorUnits }
    : { kind: "money-appeared", differenceMinor: diff as MinorUnits };
}

/**
 * parseBalanceToMinor that also accepts a leading "-" (asset accounts
 * only — card/loan negatives are rejected by decideAdjust before this
 * is reached with a minus sign... actually no: this is shared, so it
 * just parses; the caller decides what's allowed).
 */
function parseSignedBalanceToMinor(text: string, currency: string): MinorUnits | null {
  const t = text.trim();
  const negative = t.startsWith("-");
  const unsigned = negative ? t.slice(1) : t;
  const minor = parseBalanceToMinor(unsigned, currency);
  if (minor === null) return null;
  return (negative ? -minor : minor) as MinorUnits;
}

/**
 * Parse a validated balance decimal string into minor units for the given
 * currency. Returns null when the string has more decimals than the
 * currency allows (e.g. cents on a zero-decimal currency). Zero is valid.
 */
export function parseBalanceToMinor(
  text: string,
  currency: string,
): MinorUnits | null {
  const decimals = decimalsOf(currency);
  const t = text.trim();
  const pattern =
    decimals === 0 ? /^\d+$/ : new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
  if (!pattern.test(t)) return null;
  const parts = t.split(".");
  const whole = parts[0] ?? "";
  const frac = parts[1] ?? "";
  const minor = Number(whole + frac.padEnd(decimals, "0"));
  if (!Number.isSafeInteger(minor) || minor < 0) return null;
  return minor as MinorUnits;
}

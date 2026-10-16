/**
 * Turn messy bank descriptions into readable payee names (Phase B).
 * Pure and deterministic; never guesses beyond its rules.
 *
 * Examples:
 *   "PURCHASE AUTHORIZED ON 10/13 CITI BIKE*TRIP NEW YORK NY S5802871234567890 CARD 1234"
 *     -> "Citi Bike"
 *   "RECURRING PAYMENT AUTHORIZED ON 10/01 SPOTIFY USA 877-778-1161" -> "Spotify"
 *   "DIRECT DEP ROC NATION LLC PAYROLL" -> "Roc Nation"
 *   "DIRECT DEPOSIT ACME CORP PAYROLL" -> "Acme"
 *   "ZELLE TO MALIKE SIDIBE ON 10/16/2026 REF # 123" -> "Zelle to Malike Sidibe"
 */
import { normalizeDescription } from "./fingerprints.js";

/** Prefixes the bank tacks onto card purchases. */
const PREFIX_RES = [
  /^PURCHASE AUTHORIZED ON \d{1,2}\/\d{1,2} /,
  /^RECURRING PAYMENT AUTHORIZED ON \d{1,2}\/\d{1,2} /,
  /^PURCHASE AUTHORIZED /,
  /^RECURRING PAYMENT /,
  /^POS PURCHASE /,
  /^DEBIT PURCHASE /,
  /^DIRECT DEPOSIT /,
  /^DIRECT DEP /,
];

/** Trailing junk: card numbers, reference codes, phone numbers.
 * (Matched AFTER normalization, so dashes are already spaces.) */
const SUFFIX_RES = [
  /\s+S\d{8,}.*$/, // S5802871234567890-style auth codes
  /\s+CARD \d{3,}$/,
  /\s+\d{3} \d{3} \d{4}$/, // 877 778 1161 (was 877-778-1161)
  /\s+[A-Z]{2} \d{5}(-\d{4})?$/, // state + zip, e.g. "NY 10001"
  /\s+PAYROLL$/, // "ROC NATION LLC PAYROLL" -> "ROC NATION LLC"
  /\s+(LLC|INC|CO|CORP)\.?$/, // "ROC NATION LLC" -> "ROC NATION"
  /\s+USA$/, // "SPOTIFY USA" -> "SPOTIFY"
];

/**
 * Clean a raw bank description into a display payee name.
 * Returns the title-cased merchant-ish core of the description.
 */
export function cleanPayee(raw: string): string {
  // Strip bank prefixes BEFORE normalization (it removes the slashes in
  // "ON 10/13" and the "*" separator that the patterns below match on).
  let s = raw.toUpperCase();
  for (const re of PREFIX_RES) s = s.replace(re, "");
  // "CITI BIKE*TRIP NEW YORK NY" -> "CITI BIKE" (merchant before the *).
  const star = s.indexOf("*");
  if (star > 0) s = s.slice(0, star);
  s = normalizeDescription(s);
  for (const re of SUFFIX_RES) s = s.replace(re, "");
  s = s.replace(/\s+/g, " ").trim();
  // Drop trailing city/state words that survived (keep it short).
  const words = s.split(" ");
  // Heuristic: merchant names are rarely longer than 3 words; keep the
  // first 3 unless the description is a Zelle/transfer style phrase.
  if (!/^(ZELLE|ONLINE TRANSFER|DIRECT DEP)/.test(s) && words.length > 3) {
    s = words.slice(0, 3).join(" ");
  }
  return titleCase(s);
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(" ")
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Merchant key for history/rule matching: the cleaned payee, uppercased
 * and stripped of filler words. "Zelle to Malike Sidibe" and
 * "ZELLE TO MALIKE SIDIBE" key alike.
 */
export function merchantKey(cleanedPayee: string): string {
  return cleanedPayee
    .toUpperCase()
    .replace(/\b(LLC|INC|CO|CORP|USA)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the description looks like a refund/return/reversal. */
const REFUND_RES = [/\bREFUND\b/, /\bRETURN\b/, /\bREVERSAL\b/, /\bCREDIT ADJUSTMENT\b/, /\bREFUNDED\b/];

export function looksLikeRefund(description: string): boolean {
  const norm = normalizeDescription(description);
  return REFUND_RES.some((re) => re.test(norm));
}

/** True when the description looks like card interest or a fee. */
const FEE_RES = [
  /\bINTEREST CHARGE\b/,
  /\bANNUAL FEE\b/,
  /\bLATE FEE\b/,
  /\bOVERLIMIT FEE\b/,
  /\bCASH ADVANCE FEE\b/,
  /\bFOREIGN TRANSACTION FEE\b/,
  /\bMONTHLY FEE\b/,
  /\bSERVICE FEE\b/,
  /\bMAINTENANCE FEE\b/,
];

export function looksLikeFeeOrInterest(description: string): boolean {
  const norm = normalizeDescription(description);
  return FEE_RES.some((re) => re.test(norm));
}

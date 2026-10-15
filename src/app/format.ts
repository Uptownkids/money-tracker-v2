/**
 * Display formatting for money. This is presentation only: it never does
 * money math. All calculations stay in the Phase 2 engine; this only
 * renders minor-unit integers as human-readable strings.
 */
import { decimalsOf } from "../domain/money/currency.js";
import type { MinorUnits } from "../domain/money/money.js";

const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

/** e.g. formatMoney(336640, "USD") -> "$3,366.40". */
export function formatMoney(amount: MinorUnits, currency: string): string {
  const d = decimalsOf(currency);
  const major = amount / 10 ** d;
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  return (
    symbol +
    major.toLocaleString("en-US", {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    })
  );
}

/** Whole dollars, rounded display of an already-rounded-down amount. */
export function formatWhole(amount: MinorUnits, currency: string): string {
  const d = decimalsOf(currency);
  const whole = Math.trunc(amount / 10 ** d);
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  return symbol + whole.toLocaleString("en-US");
}

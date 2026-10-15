/**
 * Manual foreign-exchange conversion.
 *
 * CURRENCY SEMANTICS — read before touching conversion code:
 * - t.amount / t.currency: the amount as entered, in the transaction's currency.
 * - t.fx (optional): attached when the transaction's currency differs from
 *   the ACCOUNT's currency. fx.baseAmount is the amount converted into the
 *   ACCOUNT's currency, frozen at entry, and is authoritative for that
 *   account's totals. It is NOT in the global base currency.
 * - deriveBalances: per-account balances stay in the account's currency;
 *   each transaction contributes fx.baseAmount when present, else t.amount.
 * - Anything summing ACROSS accounts (safe-to-spend available, net worth)
 *   converts each per-account balance with
 *   convertToBase(balance, account.currency).
 * - A single transaction's contribution to a base-currency total is
 *   convertToBase(fx.baseAmount, <account currency>) when fx is present,
 *   else convertToBase(t.amount, t.currency). Never convert fx.baseAmount
 *   with t.currency (the foreign currency) — that double-converts.
 *
 * The user enters a rate manually. Converted amounts are frozen at entry
 * time: historical transactions never change when a later rate is entered.
 * The last-used rate per currency pair is remembered as the next default.
 */
import { mulDivHalfEven } from "./money.js";
import { decimalsOf } from "./currency.js";

export interface FxDetail {
  originalAmount: number; // in the foreign currency's minor units
  originalCurrency: string;
  rate: number; // foreign -> base, as entered by the user
  baseAmount: number; // converted amount, frozen at entry
}

/** Scale used to turn a user-entered float rate into an exact rational. */
const RATE_SCALE = 1_000_000_000;

/**
 * Convert foreign minor units to base minor units with banker's rounding.
 * rate means: 1 unit of foreign currency = rate units of base currency.
 */
export function convertMinor(
  amountForeignMinor: number,
  foreignCurrency: string,
  baseCurrency: string,
  rate: number,
): number {
  if (!Number.isInteger(amountForeignMinor)) {
    throw new TypeError("convertMinor: amount must be an integer");
  }
  if (!(rate > 0) || !Number.isFinite(rate)) {
    throw new RangeError(`convertMinor: rate must be a positive finite number, got ${rate}`);
  }
  const fd = decimalsOf(foreignCurrency);
  const bd = decimalsOf(baseCurrency);
  const rateNum = Math.round(rate * RATE_SCALE);
  if (rateNum <= 0) throw new RangeError("convertMinor: rate is too small to represent");
  // baseMinor = round_half_even(amountForeign * rate * 10^(bd - fd))
  const decimalShift = bd - fd;
  if (decimalShift >= 0) {
    return mulDivHalfEven(amountForeignMinor * 10 ** decimalShift, rateNum, RATE_SCALE);
  }
  return mulDivHalfEven(amountForeignMinor, rateNum, RATE_SCALE * 10 ** -decimalShift);
}

/** Build a frozen FxDetail for a new transaction. */
export function buildFxDetail(
  originalAmountMinor: number,
  originalCurrency: string,
  baseCurrency: string,
  rate: number,
): FxDetail {
  return {
    originalAmount: originalAmountMinor,
    originalCurrency,
    rate,
    baseAmount: convertMinor(originalAmountMinor, originalCurrency, baseCurrency, rate),
  };
}

function pairKey(from: string, to: string): string {
  return `${from.toUpperCase()}->${to.toUpperCase()}`;
}

/**
 * In-memory last-used rate store. The application layer persists this
 * (e.g. in settings); the domain keeps it side-effect free and testable.
 */
export class FxRateMemory {
  private rates = new Map<string, number>();

  setRate(fromCurrency: string, toCurrency: string, rate: number): void {
    if (!(rate > 0) || !Number.isFinite(rate)) {
      throw new RangeError(`FxRateMemory: rate must be positive finite, got ${rate}`);
    }
    this.rates.set(pairKey(fromCurrency, toCurrency), rate);
  }

  /** Last-used rate for the pair, or undefined when never set. */
  getRate(fromCurrency: string, toCurrency: string): number | undefined {
    return this.rates.get(pairKey(fromCurrency, toCurrency));
  }

  /** Last-used rate, defaulting to 1 for same-currency pairs. */
  getRateOrDefault(fromCurrency: string, toCurrency: string, fallback = 1): number {
    if (fromCurrency.toUpperCase() === toCurrency.toUpperCase()) return 1;
    return this.getRate(fromCurrency, toCurrency) ?? fallback;
  }
}

/** Currency metadata: ISO code, minor-unit decimals, display symbol. */

export interface Currency {
  code: string;
  decimals: number; // minor units per major unit: USD 2, JPY 0, KWD 3
  symbol: string;
}

const CURRENCIES: Record<string, Currency> = {
  USD: { code: "USD", decimals: 2, symbol: "$" },
  EUR: { code: "EUR", decimals: 2, symbol: "€" },
  GBP: { code: "GBP", decimals: 2, symbol: "£" },
  CAD: { code: "CAD", decimals: 2, symbol: "$" },
  AUD: { code: "AUD", decimals: 2, symbol: "$" },
  CHF: { code: "CHF", decimals: 2, symbol: "CHF" },
  CNY: { code: "CNY", decimals: 2, symbol: "¥" },
  INR: { code: "INR", decimals: 2, symbol: "₹" },
  MXN: { code: "MXN", decimals: 2, symbol: "$" },
  BRL: { code: "BRL", decimals: 2, symbol: "R$" },
  JPY: { code: "JPY", decimals: 0, symbol: "¥" },
  GNF: { code: "GNF", decimals: 0, symbol: "GNF " },
  KRW: { code: "KRW", decimals: 0, symbol: "₩" },
  KWD: { code: "KWD", decimals: 3, symbol: "د.ك" },
  BHD: { code: "BHD", decimals: 3, symbol: ".د.ب" },
  OMR: { code: "OMR", decimals: 3, symbol: "ر.ع." },
};

export function getCurrency(code: string): Currency {
  const c = CURRENCIES[code.toUpperCase()];
  if (!c) throw new RangeError(`Unknown currency code: ${code}`);
  return c;
}

/** Number of minor units per major unit for a currency (10^decimals). */
export function minorPerMajor(code: string): number {
  return 10 ** getCurrency(code).decimals;
}

export function decimalsOf(code: string): number {
  return getCurrency(code).decimals;
}

/** True when the code is a known ISO currency in the table. */
export function isKnownCurrency(code: string): boolean {
  return code.toUpperCase() in CURRENCIES;
}

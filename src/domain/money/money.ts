/**
 * Integer minor-unit money arithmetic.
 *
 * Every amount in the app is a `MinorUnits` integer (e.g. cents for USD).
 * No floating point is ever used for money. Division and currency
 * conversion round with banker's rounding (round half to even); the only
 * exception is safe-to-spend, which rounds DOWN to the whole unit.
 */

export type MinorUnits = number; // must be a safe integer

function assertSafeInteger(n: number, what: string): void {
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`${what} is not a safe integer: ${n}`);
  }
}

function assertInteger(n: number, what: string): void {
  if (!Number.isInteger(n)) {
    throw new TypeError(`${what} must be an integer, got ${n}`);
  }
}

/** a + b, exact. */
export function addMinor(a: MinorUnits, b: MinorUnits): MinorUnits {
  assertInteger(a, "addMinor(a)");
  assertInteger(b, "addMinor(b)");
  const r = a + b;
  assertSafeInteger(r, "addMinor result");
  return r;
}

/** a - b, exact. */
export function subMinor(a: MinorUnits, b: MinorUnits): MinorUnits {
  assertInteger(a, "subMinor(a)");
  assertInteger(b, "subMinor(b)");
  const r = a - b;
  assertSafeInteger(r, "subMinor result");
  return r;
}

/** Sum of a list, exact. */
export function sumMinor(values: readonly MinorUnits[]): MinorUnits {
  let total = 0;
  for (const v of values) {
    assertInteger(v, "sumMinor value");
    total = addMinor(total, v);
  }
  return total;
}

/**
 * Banker's rounding of the rational numerator / denominator to an integer.
 * Round half to even: 2.5 -> 2, 3.5 -> 4, -2.5 -> -2.
 */
export function divRoundHalfEven(numerator: number, denominator: number): number {
  assertInteger(numerator, "divRoundHalfEven(numerator)");
  assertInteger(denominator, "divRoundHalfEven(denominator)");
  if (denominator === 0) throw new RangeError("divRoundHalfEven: division by zero");
  const num = BigInt(numerator);
  const den = BigInt(denominator);
  const negative = num < 0n !== den < 0n;
  const absNum = num < 0n ? -num : num;
  const absDen = den < 0n ? -den : den;
  const q = absNum / absDen;
  const r = absNum % absDen;
  const twiceR = r * 2n;
  let rounded = q;
  if (twiceR > absDen) {
    rounded = q + 1n;
  } else if (twiceR === absDen && q % 2n === 1n) {
    rounded = q + 1n; // exact half -> round to even
  }
  const result = negative ? -rounded : rounded;
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError("divRoundHalfEven: result overflows safe integer range");
  }
  return Number(result);
}

/** a * b, exact (uses BigInt internally to avoid float overflow). */
export function mulMinor(a: MinorUnits, b: MinorUnits): MinorUnits {
  assertInteger(a, "mulMinor(a)");
  assertInteger(b, "mulMinor(b)");
  const r = BigInt(a) * BigInt(b);
  if (r > BigInt(Number.MAX_SAFE_INTEGER) || r < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError("mulMinor: result overflows safe integer range");
  }
  return Number(r);
}

/**
 * (a * b) / divisor with banker's rounding. The workhorse for FX
 * conversion and proportional splits.
 */
export function mulDivHalfEven(a: number, b: number, divisor: number): number {
  assertInteger(a, "mulDivHalfEven(a)");
  assertInteger(b, "mulDivHalfEven(b)");
  assertInteger(divisor, "mulDivHalfEven(divisor)");
  if (divisor === 0) throw new RangeError("mulDivHalfEven: division by zero");
  const num = BigInt(a) * BigInt(b);
  const den = BigInt(divisor);
  const negative = num < 0n !== den < 0n;
  const absNum = num < 0n ? -num : num;
  const absDen = den < 0n ? -den : den;
  const q = absNum / absDen;
  const r = absNum % absDen;
  const twiceR = r * 2n;
  let rounded = q;
  if (twiceR > absDen) {
    rounded = q + 1n;
  } else if (twiceR === absDen && q % 2n === 1n) {
    rounded = q + 1n;
  }
  const result = negative ? -rounded : rounded;
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError("mulDivHalfEven: result overflows safe integer range");
  }
  return Number(result);
}

/** Ceiling division of a by b (b > 0): smallest integer >= a / b. */
export function divCeil(a: number, b: number): number {
  assertInteger(a, "divCeil(a)");
  assertInteger(b, "divCeil(b)");
  if (b <= 0) throw new RangeError("divCeil: divisor must be positive");
  const q = Math.trunc(a / b);
  // a/b ceiling: if there is a remainder with the same sign as b, add 1
  if (a % b !== 0 && (a > 0) === (b > 0)) return q + 1;
  return q;
}

/**
 * Round down to the nearest whole currency unit (toward negative
 * infinity). Used for the safe-to-spend daily number: 1299 cents (USD)
 * -> 1200 cents ($12). Never rounds up.
 */
export function roundDownToUnit(amountMinor: MinorUnits, decimals: number): MinorUnits {
  assertInteger(amountMinor, "roundDownToUnit(amountMinor)");
  assertInteger(decimals, "roundDownToUnit(decimals)");
  if (decimals < 0) throw new RangeError("roundDownToUnit: decimals must be >= 0");
  const unit = 10 ** decimals;
  return Math.floor(amountMinor / unit) * unit;
}

/** Clamp a minor-unit value at a minimum of zero. */
export function maxZero(n: MinorUnits): MinorUnits {
  assertInteger(n, "maxZero");
  return n < 0 ? 0 : n;
}

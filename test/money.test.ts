import { describe, expect, it } from "vitest";
import {
  addMinor,
  divCeil,
  divRoundHalfEven,
  maxZero,
  mulDivHalfEven,
  mulMinor,
  roundDownToUnit,
  subMinor,
  sumMinor,
} from "../src/domain/money/money.js";
import { decimalsOf, getCurrency, isKnownCurrency, minorPerMajor } from "../src/domain/money/currency.js";
import { FxRateMemory, buildFxDetail, convertMinor } from "../src/domain/money/fx.js";
describe("integer arithmetic", () => {
  it("adds and subtracts exactly", () => {
    expect(addMinor(100, 200)).toBe(300);
    expect(subMinor(100, 200)).toBe(-100);
    expect(sumMinor([1, 2, 3, -1])).toBe(5);
  });

  it("multiplies without float error", () => {
    expect(mulMinor(123456, 789)).toBe(123456 * 789);
    expect(() => mulMinor(Number.MAX_SAFE_INTEGER, 2)).toThrow(RangeError);
  });

  it("rejects non-integers", () => {
    expect(() => addMinor(1.5, 2)).toThrow(TypeError);
    expect(() => sumMinor([100, 0.1])).toThrow(TypeError);
  });
});

describe("banker's rounding", () => {
  it("rounds half to even", () => {
    expect(divRoundHalfEven(5, 2)).toBe(2); // 2.5 -> 2
    expect(divRoundHalfEven(7, 2)).toBe(4); // 3.5 -> 4
    expect(divRoundHalfEven(1, 2)).toBe(0); // 0.5 -> 0
    expect(divRoundHalfEven(3, 2)).toBe(2); // 1.5 -> 2
    expect(divRoundHalfEven(-5, 2)).toBe(-2); // -2.5 -> -2
    expect(divRoundHalfEven(-7, 2)).toBe(-4);
  });

  it("rounds non-half values normally", () => {
    expect(divRoundHalfEven(10, 3)).toBe(3); // 3.33
    expect(divRoundHalfEven(20, 3)).toBe(7); // 6.67
    expect(divRoundHalfEven(-10, 3)).toBe(-3);
  });

  it("mulDivHalfEven handles FX-style math", () => {
    expect(mulDivHalfEven(1000, 108, 100)).toBe(1080); // €10 @1.08
    expect(mulDivHalfEven(15, 1, 10)).toBe(2); // 1.5 -> 2
    expect(mulDivHalfEven(5, 1, 10)).toBe(0); // 0.5 -> 0
    expect(() => mulDivHalfEven(1, 1, 0)).toThrow(RangeError);
  });

  it("divCeil rounds up", () => {
    expect(divCeil(10, 3)).toBe(4);
    expect(divCeil(9, 3)).toBe(3);
    expect(divCeil(0, 5)).toBe(0);
  });
});

describe("roundDownToUnit (safe-to-spend)", () => {
  it("floors to the whole unit, never up", () => {
    expect(roundDownToUnit(1299, 2)).toBe(1200);
    expect(roundDownToUnit(1200, 2)).toBe(1200);
    expect(roundDownToUnit(99, 2)).toBe(0);
    expect(roundDownToUnit(100, 0)).toBe(100); // JPY
    expect(roundDownToUnit(1999, 3)).toBe(1000); // KWD
  });

  it("maxZero clamps negatives", () => {
    expect(maxZero(-5)).toBe(0);
    expect(maxZero(7)).toBe(7);
  });
});

describe("currency metadata", () => {
  it("knows decimal places", () => {
    expect(decimalsOf("USD")).toBe(2);
    expect(decimalsOf("JPY")).toBe(0);
    expect(decimalsOf("KWD")).toBe(3);
    expect(minorPerMajor("USD")).toBe(100);
    expect(getCurrency("eur").code).toBe("EUR");
  });

  it("rejects unknown codes", () => {
    expect(() => decimalsOf("XXX")).toThrow(RangeError);
    expect(isKnownCurrency("USD")).toBe(true);
    expect(isKnownCurrency("XXX")).toBe(false);
  });
});

describe("FX conversion", () => {
  it("converts with banker's rounding", () => {
    // €10.00 -> USD @ 1.08 = $10.80
    expect(convertMinor(1000, "EUR", "USD", 1.08)).toBe(1080);
    // ¥1000 (0 decimals) -> USD @ 0.0067 = $6.70
    expect(convertMinor(1000, "JPY", "USD", 0.0067)).toBe(670);
    // $10.00 -> KWD (3 decimals) @ 0.308 = 3.080 KWD
    expect(convertMinor(1000, "USD", "KWD", 0.308)).toBe(3080);
  });

  it("rejects bad rates", () => {
    expect(() => convertMinor(100, "EUR", "USD", 0)).toThrow(RangeError);
    expect(() => convertMinor(100, "EUR", "USD", -1.5)).toThrow(RangeError);
    expect(() => convertMinor(100, "EUR", "USD", Number.NaN)).toThrow(RangeError);
  });

  it("freezes the converted amount at entry", () => {
    const fx = buildFxDetail(1000, "EUR", "USD", 1.08);
    expect(fx.baseAmount).toBe(1080);
    expect(fx.rate).toBe(1.08);
    // a later rate change produces a different NEW detail; the old one is untouched
    const fx2 = buildFxDetail(1000, "EUR", "USD", 1.2);
    expect(fx2.baseAmount).toBe(1200);
    expect(fx.baseAmount).toBe(1080);
  });
});

describe("FxRateMemory", () => {
  it("remembers the last-used rate per pair", () => {
    const m = new FxRateMemory();
    expect(m.getRate("EUR", "USD")).toBeUndefined();
    m.setRate("EUR", "USD", 1.08);
    expect(m.getRate("EUR", "USD")).toBe(1.08);
    expect(m.getRate("USD", "EUR")).toBeUndefined(); // direction matters
    m.setRate("EUR", "USD", 1.1);
    expect(m.getRate("EUR", "USD")).toBe(1.1);
  });

  it("defaults to 1 for same-currency pairs", () => {
    const m = new FxRateMemory();
    expect(m.getRateOrDefault("USD", "USD")).toBe(1);
    expect(m.getRateOrDefault("EUR", "USD", 1.5)).toBe(1.5);
  });
});

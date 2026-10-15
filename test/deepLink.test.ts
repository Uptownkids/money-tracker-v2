/** Deep-link parsing (?add= / ?adjust=) and balance-adjustment math. */
import { describe, expect, it } from "vitest";
import {
  decideAdjust,
  parseBalanceToMinor,
  parseDeepLink,
  type AddIntent,
  type AdjustIntent,
  type DeepLinkParseResult,
} from "../src/utils/deepLink.js";
import type { DateOnly } from "../src/domain/dates/dateOnly.js";
import type { MinorUnits } from "../src/domain/money/money.js";

const TODAY = "2026-10-15" as DateOnly;
const NAMES = ["Checking", "Cash", "Chase Sapphire"];

function ok(result: DeepLinkParseResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  return result.intent;
}

function err(result: DeepLinkParseResult): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  return result.error;
}

describe("parseDeepLink — no link", () => {
  it("empty string is not a link", () => {
    expect(ok(parseDeepLink("", NAMES, TODAY))).toBeNull();
  });

  it("bare ? is not a link", () => {
    expect(ok(parseDeepLink("?", NAMES, TODAY))).toBeNull();
  });

  it("params without add/adjust are rejected", () => {
    expect(err(parseDeepLink("?foo=bar", NAMES, TODAY))).toMatch(/not a Money Tracker link/);
  });

  it("add and adjust together are rejected", () => {
    expect(err(parseDeepLink("?add=expense&adjust=Checking", NAMES, TODAY))).toMatch(
      /can't combine/,
    );
  });
});

describe("parseDeepLink — ?add=", () => {
  const base = "?add=expense&amount=12.50&payee=Chipotle&account=checking&date=2026-10-15";

  it("parses a valid expense link", () => {
    const intent = ok(parseDeepLink(base, NAMES, TODAY)) as AddIntent;
    expect(intent.kind).toBe("add");
    expect(intent.entryType).toBe("Expense");
    expect(intent.amountText).toBe("12.50");
    expect(intent.payee).toBe("Chipotle");
    expect(intent.accountName).toBe("Checking");
    expect(intent.date).toBe("2026-10-15");
  });

  it("parses a valid income link", () => {
    const intent = ok(
      parseDeepLink("?add=income&amount=2000&payee=Paycheck&account=Checking", NAMES, TODAY),
    ) as AddIntent;
    expect(intent.entryType).toBe("Income");
    expect(intent.amountText).toBe("2000");
  });

  it("entry type is case-insensitive", () => {
    const intent = ok(
      parseDeepLink("?add=Expense&amount=5&payee=X&account=Cash", NAMES, TODAY),
    ) as AddIntent;
    expect(intent.entryType).toBe("Expense");
  });

  it("date defaults to today when omitted", () => {
    const intent = ok(
      parseDeepLink("?add=expense&amount=5&payee=X&account=Cash", NAMES, TODAY),
    ) as AddIntent;
    expect(intent.date).toBe(TODAY);
  });

  it("accepts a valid leap-day date", () => {
    const intent = ok(
      parseDeepLink("?add=expense&amount=5&payee=X&account=Cash&date=2024-02-29", NAMES, TODAY),
    ) as AddIntent;
    expect(intent.date).toBe("2024-02-29");
  });

  it("URL-decodes the payee", () => {
    const intent = ok(
      parseDeepLink("?add=expense&amount=5&payee=Blue%20Bottle%20Coffee&account=Cash", NAMES, TODAY),
    ) as AddIntent;
    expect(intent.payee).toBe("Blue Bottle Coffee");
  });

  it("matches accounts case-insensitively", () => {
    const intent = ok(
      parseDeepLink("?add=expense&amount=5&payee=X&account=CHASE%20SAPPHIRE", NAMES, TODAY),
    ) as AddIntent;
    expect(intent.accountName).toBe("Chase Sapphire");
  });

  it("rejects transfer with a clear error", () => {
    expect(
      err(parseDeepLink("?add=transfer&amount=5&payee=X&account=Cash", NAMES, TODAY)),
    ).toMatch(/transfers/);
  });

  it("rejects an unknown entry type", () => {
    expect(
      err(parseDeepLink("?add=refund&amount=5&payee=X&account=Cash", NAMES, TODAY)),
    ).toMatch(/expense or income/);
  });

  it("rejects a missing entry type value", () => {
    expect(
      err(parseDeepLink("?add=&amount=5&payee=X&account=Cash", NAMES, TODAY)),
    ).toMatch(/expense or income/);
  });

  it.each(["abc", "-5", "0", "0.00", "$12", "1,000", "12.50.3", ""])(
    "rejects bad amount %p",
    (amount) => {
      expect(
        err(
          parseDeepLink(
            `?add=expense&amount=${encodeURIComponent(amount)}&payee=X&account=Cash`,
            NAMES,
            TODAY,
          ),
        ),
      ).toMatch(/amount/);
    },
  );

  it("rejects a missing amount", () => {
    expect(
      err(parseDeepLink("?add=expense&payee=X&account=Cash", NAMES, TODAY)),
    ).toMatch(/missing amount/);
  });

  it("rejects an empty payee", () => {
    expect(
      err(parseDeepLink("?add=expense&amount=5&payee=%20%20&account=Cash", NAMES, TODAY)),
    ).toMatch(/payee/);
  });

  it("rejects a missing payee", () => {
    expect(
      err(parseDeepLink("?add=expense&amount=5&account=Cash", NAMES, TODAY)),
    ).toMatch(/payee/);
  });

  it("rejects an unknown account", () => {
    expect(
      err(parseDeepLink("?add=expense&amount=5&payee=X&account=checkin", NAMES, TODAY)),
    ).toMatch(/account "checkin" not found/);
  });

  it("rejects an ambiguous account instead of guessing", () => {
    expect(
      err(parseDeepLink("?add=expense&amount=5&payee=X&account=checking", ["Checking", " Checking "], TODAY)),
    ).toMatch(/more than one account/);
  });

  it("rejects a missing account", () => {
    expect(
      err(parseDeepLink("?add=expense&amount=5&payee=X", NAMES, TODAY)),
    ).toMatch(/account is missing/);
  });

  it.each(["2026-13-01", "2026-02-30", "not-a-date", "10/15/2026", "2026-1-5"])(
    "rejects bad date %p",
    (date) => {
      expect(
        err(
          parseDeepLink(
            `?add=expense&amount=5&payee=X&account=Cash&date=${encodeURIComponent(date)}`,
            NAMES,
            TODAY,
          ),
        ),
      ).toMatch(/date/);
    },
  );

  it("rejects unknown parameters", () => {
    expect(
      err(parseDeepLink(`${base}&foo=bar`, NAMES, TODAY)),
    ).toMatch(/unknown parameter "foo"/);
  });

  it("never returns a partial intent on failure", () => {
    const result = parseDeepLink("?add=expense&amount=abc&payee=X&account=Nope", NAMES, TODAY);
    expect(result.ok).toBe(false);
  });
});

describe("parseDeepLink — ?adjust=", () => {
  it("parses a valid adjust link", () => {
    const intent = ok(parseDeepLink("?adjust=checking&balance=30", NAMES, TODAY)) as AdjustIntent;
    expect(intent.kind).toBe("adjust");
    expect(intent.accountName).toBe("Checking");
    expect(intent.balanceText).toBe("30");
  });

  it("allows a zero balance", () => {
    const intent = ok(parseDeepLink("?adjust=Cash&balance=0", NAMES, TODAY)) as AdjustIntent;
    expect(intent.balanceText).toBe("0");
  });

  it("allows a negative balance (overdrawn asset account; cards reject it in decideAdjust)", () => {
    const intent = ok(parseDeepLink("?adjust=Cash&balance=-50", NAMES, TODAY)) as AdjustIntent;
    expect(intent.balanceText).toBe("-50");
  });

  it.each(["abc", ""])("rejects bad balance %p", (balance) => {
    expect(
      err(parseDeepLink(`?adjust=Cash&balance=${encodeURIComponent(balance)}`, NAMES, TODAY)),
    ).toMatch(/balance/);
  });

  it("rejects a missing balance", () => {
    expect(err(parseDeepLink("?adjust=Cash", NAMES, TODAY))).toMatch(/missing balance/);
  });

  it("rejects an unknown account", () => {
    expect(err(parseDeepLink("?adjust=Nope&balance=30", NAMES, TODAY))).toMatch(/not found/);
  });

  it("rejects an empty account", () => {
    expect(err(parseDeepLink("?adjust=%20&balance=30", NAMES, TODAY))).toMatch(/account/);
  });

  it("rejects unknown parameters", () => {
    expect(err(parseDeepLink("?adjust=Cash&balance=30&date=2026-10-15", NAMES, TODAY))).toMatch(
      /unknown parameter "date"/,
    );
  });
});

describe("decideAdjust", () => {
  const decide = (
    accountType: "Checking" | "CreditCard" | "Loan" | "Cash",
    appBalanceMinor: number,
    statedText: string,
  ) =>
    decideAdjust({
      accountType,
      appBalanceMinor: appBalanceMinor as MinorUnits,
      statedText,
      currency: "USD",
    });

  it("asset: app above stated is unlogged spending with the positive difference", () => {
    expect(decide("Checking", 10000, "30")).toEqual({
      kind: "unlogged-spending",
      differenceMinor: 7000,
    });
  });

  it("asset: stated above app is money-appeared, not income", () => {
    expect(decide("Checking", 2000, "50")).toEqual({
      kind: "money-appeared",
      differenceMinor: 3000,
    });
  });

  it("asset: equal balances match with nothing to record", () => {
    expect(decide("Checking", 3000, "30")).toEqual({ kind: "match" });
  });

  it("asset: a one-cent difference still counts", () => {
    expect(decide("Checking", 3000, "30.01")).toEqual({
      kind: "money-appeared",
      differenceMinor: 1,
    });
  });

  it("asset: overdrawn stated (negative) is allowed", () => {
    // App shows $100, he says -$50: $150 missing.
    expect(decide("Checking", 10000, "-50")).toEqual({
      kind: "unlogged-spending",
      differenceMinor: 15000,
    });
  });

  it("asset: negative stated below app balance is money-appeared", () => {
    // App shows -$100 (overdrawn), he says -$40: $60 appeared.
    expect(decide("Checking", -10000, "-40")).toEqual({
      kind: "money-appeared",
      differenceMinor: 6000,
    });
  });

  it("card: stated owed higher than app is unlogged spending", () => {
    // App shows $934.92 owed (stored -93492), he says $1000 owed.
    expect(decide("CreditCard", -93492, "1000")).toEqual({
      kind: "unlogged-spending",
      differenceMinor: 6508,
    });
  });

  it("card: stated owed lower than app is a correction, never income", () => {
    // Owes $934.92 in the app, really owes $800: $134.92 paydown.
    const d = decide("CreditCard", -93492, "800");
    expect(d).toEqual({ kind: "correction", differenceMinor: 13492 });
    expect(d.kind).not.toBe("money-appeared");
  });

  it("card: matching owed amount is a match", () => {
    expect(decide("CreditCard", -93492, "934.92")).toEqual({ kind: "match" });
  });

  it("card: negative stated is rejected with the owed-as-positive message", () => {
    expect(decide("CreditCard", -93492, "-50")).toEqual({
      kind: "invalid",
      error: "enter the amount owed as a positive number",
    });
  });

  it("loan: owed down is a correction", () => {
    expect(decide("Loan", -148835, "1400")).toEqual({
      kind: "correction",
      differenceMinor: 8835,
    });
  });

  it("garbage stated text is invalid", () => {
    const d = decide("Checking", 10000, "abc");
    expect(d.kind).toBe("invalid");
    if (d.kind === "invalid") expect(d.error).toMatch(/isn't a valid amount/);
  });

  it("stated text with too many decimals for the currency is invalid", () => {
    const d = decideAdjust({
      accountType: "Checking",
      appBalanceMinor: 10000 as MinorUnits,
      statedText: "30.001",
      currency: "USD",
    });
    expect(d.kind).toBe("invalid");
  });
});

describe("parseBalanceToMinor", () => {
  it("parses USD dollars to cents", () => {
    expect(parseBalanceToMinor("30", "USD")).toBe(3000);
    expect(parseBalanceToMinor("30.5", "USD")).toBe(3050);
    expect(parseBalanceToMinor("0", "USD")).toBe(0);
  });

  it("rejects more decimals than the currency allows", () => {
    expect(parseBalanceToMinor("30.555", "USD")).toBeNull();
    expect(parseBalanceToMinor("30.5", "JPY")).toBeNull();
  });

  it("parses zero-decimal currencies whole", () => {
    expect(parseBalanceToMinor("30", "JPY")).toBe(30);
  });
});

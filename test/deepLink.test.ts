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

  it.each(["-5", "abc", ""])("rejects bad balance %p", (balance) => {
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
  it("app above stated is unlogged spending with the positive difference", () => {
    const d = decideAdjust(10000 as MinorUnits, 3000 as MinorUnits);
    expect(d).toEqual({ kind: "spending", differenceMinor: 7000 });
  });

  it("stated above app is unlogged income with the positive difference", () => {
    const d = decideAdjust(2000 as MinorUnits, 5000 as MinorUnits);
    expect(d).toEqual({ kind: "income", differenceMinor: 3000 });
  });

  it("equal balances match with nothing to record", () => {
    expect(decideAdjust(3000 as MinorUnits, 3000 as MinorUnits)).toEqual({ kind: "match" });
  });

  it("a one-cent difference still counts", () => {
    const d = decideAdjust(3000 as MinorUnits, 3001 as MinorUnits);
    expect(d).toEqual({ kind: "income", differenceMinor: 1 });
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

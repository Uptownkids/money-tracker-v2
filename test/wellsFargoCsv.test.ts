/** Wells Fargo CSV parser tests (Phase A). Fixtures use realistic sample rows. */
import { describe, expect, it } from "vitest";
import {
  extractStableId,
  parseAmountToMinor,
  parseWellsFargoCsv,
  splitCsvLine,
  DEFAULT_COLUMN_MAP,
} from "../src/domain/import/wellsFargoCsv.js";

const CHECKING_CSV = `Date,Amount,*,*,Description
10/14/2026,-8.76,,,"PURCHASE AUTHORIZED ON 10/13 CITI BIKE*TRIP NEW YORK NY S5802871234567890 CARD 1234"
10/15/2026,2263.41,,,"DIRECT DEP ROC NATION LLC PAYROLL"
10/15/2026,-150.00,,,"ONLINE TRANSFER TO SIDIBE M WAY2SAVE SAVINGS"
10/16/2026,-1000.00,,,"ONLINE TRANSFER TO AMEX SAVINGS"
10/16/2026,-25.00,,,"ZELLE TO MALIKE SIDIBE ON 10/16/2026 REF # 9876543210"
10/17/2026,25.00,,,"ZELLE FROM MALIKE SIDIBE ON 10/17/2026 REF # 9876543211"
`;

describe("splitCsvLine", () => {
  it("handles quoted fields with commas", () => {
    expect(splitCsvLine(`10/14/2026,-8.76,,,"A, B, C"`)).toEqual([
      "10/14/2026",
      "-8.76",
      "",
      "",
      "A, B, C",
    ]);
  });

  it("handles escaped quotes", () => {
    expect(splitCsvLine(`"A ""quoted"" field",2`)).toEqual(['A "quoted" field', "2"]);
  });
});

describe("parseAmountToMinor", () => {
  it("parses signed decimals to integer minor units", () => {
    expect(parseAmountToMinor("-8.76")).toBe(-876);
    expect(parseAmountToMinor("2263.41")).toBe(226341);
    expect(parseAmountToMinor("$1,234.56")).toBe(123456);
    expect(parseAmountToMinor("(8.76)")).toBe(-876);
    expect(parseAmountToMinor("10")).toBe(1000);
  });

  it("rejects garbage", () => {
    expect(parseAmountToMinor("")).toBeNull();
    expect(parseAmountToMinor("abc")).toBeNull();
    expect(parseAmountToMinor("12.345")).toBeNull();
  });
});

describe("parseWellsFargoCsv", () => {
  it("parses a realistic checking export", () => {
    const { rows, errors } = parseWellsFargoCsv(CHECKING_CSV);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({
      date: "2026-10-14",
      amountMinor: -876,
      lineNumber: 2,
    });
    expect(rows[1]).toMatchObject({ date: "2026-10-15", amountMinor: 226341 });
    // Outflows stay negative under the default convention.
    expect(rows[2]).toMatchObject({ amountMinor: -15000 });
  });

  it("extracts Zelle Ref # as the stable id", () => {
    const { rows } = parseWellsFargoCsv(CHECKING_CSV);
    expect(rows[4]?.stableId).toBe("zelle:9876543210");
    expect(rows[5]?.stableId).toBe("zelle:9876543211");
    expect(rows[0]?.stableId).toBeUndefined();
  });

  it("inverts the sign convention when asked (card exports)", () => {
    const csv = `Date,Amount,*,*,Description\n10/14/2026,42.50,,,"COFFEE SHOP"\n`;
    const std = parseWellsFargoCsv(csv);
    expect(std.rows[0]?.amountMinor).toBe(4250);
    const inv = parseWellsFargoCsv(csv, { sign: "negative-is-inflow" });
    expect(inv.rows[0]?.amountMinor).toBe(-4250);
  });

  it("collects errors instead of throwing", () => {
    const csv = [
      "Date,Amount,*,*,Description",
      "10/14/2026,-8.76,,,\"OK ROW\"",
      "not-a-date,-8.76,,,\"BAD DATE\"",
      "10/15/2026,abc,,,\"BAD AMOUNT\"",
      "10/16/2026",
    ].join("\n");
    const { rows, errors } = parseWellsFargoCsv(csv);
    expect(rows).toHaveLength(1);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/line 3/i);
  });

  it("skips blank lines and works without a header", () => {
    const csv = `10/14/2026,-8.76,,,"ROW ONE"\n\n10/15/2026,5.00,,,"ROW TWO"\n`;
    const { rows, errors } = parseWellsFargoCsv(csv, { skipHeader: false });
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
  });

  it("honours a custom column map", () => {
    const csv = `Description,Date,Amount\n"COFFEE",10/14/2026,-4.50\n`;
    const { rows, errors } = parseWellsFargoCsv(csv, {
      columnMap: { date: 1, amount: 2, description: 0, dateFormat: "MM/DD/YYYY" },
    });
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "2026-10-14",
      amountMinor: -450,
      description: "COFFEE",
    });
    expect(DEFAULT_COLUMN_MAP.date).toBe(0);
  });
});

describe("extractStableId", () => {
  it("finds Zelle refs in messy descriptions", () => {
    expect(extractStableId("ZELLE TO MALIKE SIDIBE ON 10/16/2026 REF # ABC-123")).toBe(
      "zelle:ABC-123",
    );
    expect(extractStableId("PURCHASE AUTHORIZED ON 10/13 CITI BIKE")).toBeUndefined();
  });
});

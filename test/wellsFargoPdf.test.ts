/**
 * Wells Fargo statement PDF parser tests. Fixtures are synthetic
 * (fake payees/amounts) laid out at the real column x-positions; no
 * real statement data lives here.
 */
import { describe, expect, it } from "vitest";
import {
  detectStatementDate,
  parseWellsFargoPdf,
  type PdfPage,
  type PdfTextItem,
} from "../src/domain/import/wellsFargoPdf.js";

// Real column geometry (points).
const X_DATE = 62;
const X_DESC = 150;
const X1_DEPOSIT = 434;
const X1_WITHDRAWAL = 502;
const X1_BALANCE = 566;

let y = 1000;
function item(x: number, x1: number, text: string): PdfTextItem {
  y -= 1; // every item on its own y keeps line grouping trivial in fixtures
  return { x, x1, y, text };
}
function line(...items: PdfTextItem[]): PdfTextItem[] {
  const yy = y;
  for (const i of items) i.y = yy;
  y -= 18;
  return items.sort((a, b) => a.x - b.x);
}
function page(...lines: PdfTextItem[][]): PdfPage {
  return { lines };
}
const header = () =>
  line(item(36, 90, "Transaction"), item(96, 130, "history"));
const colHeader = () =>
  line(
    item(63, 78, "Date"),
    item(150, 186, "Description"),
    item(404, 434, "Deposits/"),
    item(458, 502, "Withdrawals/"),
  );
const footer = () =>
  line(
    item(36, 120, "August"),
    item(122, 140, "25,"),
    item(142, 170, "2026"),
    item(400, 440, "Page"),
    item(442, 460, "12"),
    item(462, 480, "of"),
    item(482, 500, "16"),
  );

function txLine(date: string, desc: string, amount: string, x1: number): PdfTextItem[] {
  return line(
    item(X_DATE, X_DATE + 20, date),
    item(X_DESC, X_DESC + desc.length * 5, desc),
    item(x1 - 30, x1, amount),
  );
}
function cont(desc: string): PdfTextItem[] {
  return line(item(X_DESC, X_DESC + desc.length * 5, desc));
}

const OPTS = { statementYear: 2026, statementMonth: 8 };

describe("parseWellsFargoPdf", () => {
  it("parses deposits and withdrawals with wrapped descriptions", () => {
    const pages = [
      page(
        header(),
        colHeader(),
        txLine("8/10", "Online Transfer From Savings xxxxxx1100", "70.00", X1_DEPOSIT),
        cont("Ref #Ab1Cd2EfGh on 08/10/26"),
        txLine("8/10", "Purchase authorized on 08/09 Corner Deli", "8.09", X1_WITHDRAWAL),
        cont("S123456789012345 Card 0301"),
      ),
    ];
    const { rows, errors } = parseWellsFargoPdf(pages, OPTS);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      date: "2026-08-10",
      amountMinor: 7000,
      description: "Online Transfer From Savings xxxxxx1100 Ref #Ab1Cd2EfGh on 08/10/26",
    });
    expect(rows[1]).toMatchObject({
      date: "2026-08-10",
      amountMinor: -809,
      description: "Purchase authorized on 08/09 Corner Deli S123456789012345 Card 0301",
    });
  });

  it("ignores the ending-daily-balance column", () => {
    const pages = [
      page(
        header(),
        colHeader(),
        line(
          item(X_DATE, X_DATE + 20, "8/11"),
          item(X_DESC, X_DESC + 100, "Purchase authorized on 08/10 Deli"),
          item(X1_WITHDRAWAL - 30, X1_WITHDRAWAL, "33.32"),
          item(X1_BALANCE - 30, X1_BALANCE, "92.18"),
        ),
      ),
    ];
    const { rows } = parseWellsFargoPdf(pages, OPTS);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amountMinor).toBe(-3332);
  });

  it("stops at the Totals row and handles comma amounts", () => {
    const pages = [
      page(
        header(),
        colHeader(),
        txLine("8/19", "Instant Pmt From Stripe Payments", "1,647.98", X1_DEPOSIT),
        line(
          item(X_DESC, X_DESC + 40, "Totals"),
          item(X1_DEPOSIT - 50, X1_DEPOSIT, "$8,684.53"),
          item(X1_WITHDRAWAL - 50, X1_WITHDRAWAL, "$7,359.47"),
        ),
        txLine("8/20", "Should never parse", "1.00", X1_WITHDRAWAL),
      ),
    ];
    const { rows } = parseWellsFargoPdf(pages, OPTS);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amountMinor).toBe(164798);
  });

  it("joins 3-line descriptions and spans page breaks", () => {
    const pages = [
      page(
        header(),
        colHeader(),
        txLine("8/17", "Non-WF ATM Withdrawal authorized on 08/15 199 Grand", "123.00", X1_WITHDRAWAL),
        cont("Street New York NY 306227860898121 ATM ID NW59756 Card"),
      ),
      page(
        header(),
        colHeader(),
        cont("0301"),
        txLine("8/18", "Zelle From Jane Doe on 08/18 Ref # Axprdldpkuyz", "10.00", X1_DEPOSIT),
      ),
    ];
    const { rows } = parseWellsFargoPdf(pages, OPTS);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.description).toBe(
      "Non-WF ATM Withdrawal authorized on 08/15 199 Grand Street New York NY 306227860898121 ATM ID NW59756 Card 0301",
    );
    expect(rows[0]!.amountMinor).toBe(-12300);
    expect(rows[1]!.stableId).toBe("zelle:AXPRDLDPKUYZ");
  });

  it("resolves M/D years from the statement date", () => {
    const pages = [
      page(
        header(),
        colHeader(),
        txLine("7/24", "Purchase authorized on 07/23 Deli", "5.00", X1_WITHDRAWAL),
        txLine("8/25", "Purchase authorized on 08/24 Deli", "6.00", X1_WITHDRAWAL),
      ),
    ];
    const { rows } = parseWellsFargoPdf(pages, OPTS);
    expect(rows[0]!.date).toBe("2026-07-24");
    expect(rows[1]!.date).toBe("2026-08-25");

    // December statement: January dates belong to the prior year.
    const jan = parseWellsFargoPdf(pages, { statementYear: 2027, statementMonth: 1 });
    expect(jan.rows[0]!.date).toBe("2026-07-24");
    expect(jan.rows[1]!.date).toBe("2026-08-25");
    const decPages = [
      page(
        header(),
        colHeader(),
        txLine("12/20", "Purchase authorized on 12/19 Deli", "5.00", X1_WITHDRAWAL),
      ),
    ];
    expect(parseWellsFargoPdf(decPages, { statementYear: 2027, statementMonth: 1 }).rows[0]!.date).toBe(
      "2026-12-20",
    );
  });

  it("ignores page footers and headers mid-table", () => {
    const pages = [
      page(
        header(),
        colHeader(),
        txLine("8/10", "Purchase authorized on 08/09 Deli", "8.09", X1_WITHDRAWAL),
        footer(),
      ),
      page(header(), colHeader(), txLine("8/11", "Purchase authorized on 08/10 Deli", "9.09", X1_WITHDRAWAL)),
    ];
    const { rows } = parseWellsFargoPdf(pages, OPTS);
    expect(rows).toHaveLength(2);
    // Footer words must not leak into descriptions.
    expect(rows[0]!.description).toBe("Purchase authorized on 08/09 Deli");
    expect(rows[1]!.description).toBe("Purchase authorized on 08/10 Deli");
  });
});

describe("detectStatementDate", () => {
  it("finds Month DD, YYYY in page headers", () => {
    const pages = [page(footer())];
    expect(detectStatementDate(pages)).toEqual({ year: 2026, month: 8 });
  });

  it("returns null when absent", () => {
    expect(detectStatementDate([page(line(item(36, 90, "Hello")) )])).toBeNull();
  });

  it("drops header words merged into a line by pdf.js grouping", () => {
    const pages = [
      page(
        header(),
        colHeader(),
        txLine("8/10", "Purchase authorized on 08/09 Deli", "8.09", X1_WITHDRAWAL),
        // pdf.js put the "Deposits/" header word on the continuation line.
        line(
          item(X_DESC, X_DESC + 100, "S123456789012345 Card 0301"),
          item(404, 434, "Deposits/"),
        ),
      ),
    ];
    const { rows } = parseWellsFargoPdf(pages, OPTS);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.description).toBe(
      "Purchase authorized on 08/09 Deli S123456789012345 Card 0301",
    );
  });
});

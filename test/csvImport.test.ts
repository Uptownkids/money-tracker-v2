/** CSV import orchestration tests: preview, commit, dedup, rollback (Phase A). */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { MoneyTrackerDB } from "../src/data/db.js";
import { createRepositories, type Repositories } from "../src/data/repositories/index.js";
import {
  commitCsvImport,
  previewCsvImport,
  rollbackImportBatch,
  suggestBankKey,
  type CsvFileInput,
} from "../src/app/csvImport.js";
import { mkAccount, mkCategory } from "./helpers.js";

const CHECKING_CSV = `Date,Amount,*,*,Description
10/14/2026,-8.76,,,"CITI BIKE TRIP"
10/15/2026,2263.41,,,"DIRECT DEP ROC NATION PAYROLL"
10/15/2026,-150.00,,,"ONLINE TRANSFER TO SIDIBE M WAY2SAVE SAVINGS"
`;

const OVERLAP_CSV = `Date,Amount,*,*,Description
10/15/2026,-150.00,,,"ONLINE TRANSFER TO SIDIBE M WAY2SAVE SAVINGS"
10/16/2026,-4.50,,,"COFFEE SHOP"
`;

const TWINS_CSV = `Date,Amount,*,*,Description
10/16/2026,-4.50,,,"COFFEE SHOP"
10/16/2026,-4.50,,,"COFFEE SHOP"
`;

describe("csvImport", () => {
  let db: MoneyTrackerDB;
  let repos: Repositories;

  const file = (name: string, text: string): CsvFileInput => ({
    fileName: name,
    text,
    bankKey: suggestBankKey(name),
    appAccountId: "acct-checking",
  });

  afterEach(async () => {
    await db?.delete();
  });

  async function setup() {
    db = new MoneyTrackerDB(`test-csv-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    repos = createRepositories(db);
    await repos.accounts.put(mkAccount({ id: "acct-checking", name: "Checking" }));
    await repos.categories.put(mkCategory({ id: "cat-other", name: "Other", kind: "expense" }));
    await repos.categories.put(mkCategory({ id: "cat-income", name: "Income", kind: "income" }));
  }

  it("previews, commits, and creates Cleared transactions", async () => {
    await setup();
    const preview = await previewCsvImport(repos, [file("checking.csv", CHECKING_CSV)]);
    expect(preview.newCount).toBe(3);
    expect(preview.duplicateCount).toBe(0);
    expect(preview.files[0]?.errors).toEqual([]);

    const { batch, importedIds } = await commitCsvImport(repos, preview, [
      file("checking.csv", CHECKING_CSV),
    ]);
    expect(importedIds).toHaveLength(3);
    expect(batch.stats).toMatchObject({ rows: 3, imported: 3, duplicates: 0 });
    expect(batch.status).toBe("committed");

    const txs = await repos.transactions.getAll();
    expect(txs).toHaveLength(3);
    for (const t of txs) {
      expect(t.status).toBe("Cleared");
      expect(t.importBatchId).toBe(batch.id);
      expect(t.bankFingerprint).toBeTruthy();
    }
    // Sign decides the naive Phase-A type: outflows are Expenses.
    const coffee = txs.find((t) => t.payee === "CITI BIKE TRIP");
    expect(coffee).toMatchObject({ type: "Expense", amount: 876 });
    const payroll = txs.find((t) => t.payee === "DIRECT DEP ROC NATION PAYROLL");
    expect(payroll).toMatchObject({ type: "Income", amount: 226341 });
  });

  it("re-importing the same file creates zero new rows", async () => {
    await setup();
    const f = file("checking.csv", CHECKING_CSV);
    const p1 = await previewCsvImport(repos, [f]);
    await commitCsvImport(repos, p1, [f]);

    const p2 = await previewCsvImport(repos, [f]);
    expect(p2.newCount).toBe(0);
    expect(p2.duplicateCount).toBe(3);
    await expect(commitCsvImport(repos, p2, [f])).rejects.toThrow(/nothing new to import/);
    expect(await repos.transactions.getAll()).toHaveLength(3);
  });

  it("dedups across overlapping files in one import", async () => {
    await setup();
    const preview = await previewCsvImport(repos, [
      file("2024.csv", CHECKING_CSV),
      file("2025.csv", OVERLAP_CSV),
    ]);
    // 3 + 2 rows, one overlap -> 4 new, 1 duplicate.
    expect(preview.newCount).toBe(4);
    expect(preview.duplicateCount).toBe(1);

    const { importedIds } = await commitCsvImport(repos, preview, [
      file("2024.csv", CHECKING_CSV),
      file("2025.csv", OVERLAP_CSV),
    ]);
    expect(importedIds).toHaveLength(4);
    expect(await repos.transactions.getAll()).toHaveLength(4);
  });

  it("imports two identical same-day rows when neither was seen", async () => {
    await setup();
    const preview = await previewCsvImport(repos, [file("twins.csv", TWINS_CSV)]);
    expect(preview.newCount).toBe(2);
    await commitCsvImport(repos, preview, [file("twins.csv", TWINS_CSV)]);
    expect(await repos.transactions.getAll()).toHaveLength(2);
  });

  it("rolls a batch back completely", async () => {
    await setup();
    const f = file("checking.csv", CHECKING_CSV);
    const preview = await previewCsvImport(repos, [f]);
    const { batch } = await commitCsvImport(repos, preview, [f]);
    expect(await repos.transactions.getAll()).toHaveLength(3);

    const { deletedTransactions } = await rollbackImportBatch(repos, batch.id);
    expect(deletedTransactions).toBe(3);
    expect(await repos.transactions.getAll()).toHaveLength(0);
    expect((await repos.importBatches.getById(batch.id))?.status).toBe("rolled-back");
    // Fingerprints are forgotten, so the rows become importable again.
    const p2 = await previewCsvImport(repos, [f]);
    expect(p2.newCount).toBe(3);
    await expect(rollbackImportBatch(repos, batch.id)).rejects.toThrow(/already rolled back/);
  });

  it("remembers the bank -> app account mapping", async () => {
    await setup();
    const f = file("wf-checking.csv", CHECKING_CSV);
    const preview = await previewCsvImport(repos, [f]);
    await commitCsvImport(repos, preview, [f]);

    const maps = await repos.bankAccountMaps.getAll();
    expect(maps).toHaveLength(1);
    expect(maps[0]).toMatchObject({ bankKey: "wf-checking", appAccountId: "acct-checking" });
  });

  it("rejects an unknown account id before parsing", async () => {
    await setup();
    const bad: CsvFileInput = { ...file("x.csv", CHECKING_CSV), appAccountId: "nope" };
    await expect(previewCsvImport(repos, [bad])).rejects.toThrow(/unknown appAccountId/);
  });

  it("suggestBankKey derives a label from the file name", () => {
    expect(suggestBankKey("WF Checking 2024.csv")).toBe("wf-checking-2024");
  });

  it("previews and commits pre-parsed PDF statement rows", async () => {
    await setup();
    const pdfFile: CsvFileInput = {
      fileName: "Bank_statement_08_2026.pdf",
      text: "",
      bankKey: "bank-statement-08-2026",
      appAccountId: "acct-checking",
      kind: "pdf",
      statementLabel: "August 2026",
      parsedRows: [
        { date: "2026-08-10", amountMinor: 7000, description: "Online Transfer From Savings", lineNumber: 3 },
        { date: "2026-08-10", amountMinor: -809, description: "Corner Deli", lineNumber: 5 },
      ],
      parseErrors: ["Line 7: no amount found, skipped."],
    };
    const preview = await previewCsvImport(repos, [pdfFile]);
    expect(preview.newCount).toBe(2);
    expect(preview.files[0]?.errors).toEqual(["Line 7: no amount found, skipped."]);
    expect(preview.files[0]?.rows).toBe(2);

    const { importedIds } = await commitCsvImport(repos, preview, [pdfFile]);
    expect(importedIds).toHaveLength(2);
    const txs = await repos.transactions.getAll();
    expect(txs).toHaveLength(2);
    expect(txs.map((t) => t.payee)).toContain("Online Transfer From Savings");
  });

  it("mixes CSV and PDF files in one preview", async () => {
    await setup();
    const pdfFile: CsvFileInput = {
      fileName: "stmt.pdf",
      text: "",
      bankKey: "stmt",
      appAccountId: "acct-checking",
      kind: "pdf",
      parsedRows: [{ date: "2026-08-10", amountMinor: -809, description: "Corner Deli", lineNumber: 5 }],
    };
    const preview = await previewCsvImport(repos, [file("checking.csv", CHECKING_CSV), pdfFile]);
    expect(preview.newCount).toBe(4);
    expect(preview.files).toHaveLength(2);
  });
});

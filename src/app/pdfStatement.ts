/**
 * Bank statement PDF reading (all on-device via pdf.js — the file never
 * leaves the phone). Extracts positioned text per page, then runs the
 * Wells Fargo statement parser from the domain layer.
 */
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  detectStatementDate,
  parseWellsFargoPdf,
  type PdfPage,
} from "../domain/import/wellsFargoPdf.js";
import type { ParsedBankRow } from "../domain/import/wellsFargoCsv.js";

/** Max pages to read from one statement (a year's statements stay well under). */
const MAX_PAGES = 60;

/** Items on the same visual line share a baseline within ~3pt. */
const LINE_TOLERANCE_PT = 3;

export interface PdfStatementParse {
  rows: ParsedBankRow[];
  errors: string[];
  /** e.g. "August 2026" — shown so the user can sanity-check the file. */
  statementLabel: string;
}

/** Read positioned text lines from every page of the PDF. */
export async function extractPdfPages(file: File): Promise<PdfPage[]> {
  // Dynamically imported so the pdf.js chunk only loads when a PDF is picked.
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
  const buf = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buf) });
  const pdf = await loadingTask.promise;
  try {
    const pages: PdfPage[] = [];
    const count = Math.min(pdf.numPages, MAX_PAGES);
    for (let p = 1; p <= count; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const items = content.items
        .filter(
          (it): it is typeof it & { str: string; transform: number[]; width: number } =>
            "str" in it && typeof it.str === "string" && it.str.trim() !== "",
        )
        .map((it) => ({
          x: it.transform[4] ?? 0,
          x1: (it.transform[4] ?? 0) + (it.width ?? 0),
          y: it.transform[5] ?? 0,
          text: it.str,
        }));
      // Top-to-bottom, then group into lines by baseline.
      const sorted = [...items].sort((a, b) => b.y - a.y);
      const lines: PdfPage["lines"] = [];
      for (const it of sorted) {
        const line = lines.find((l) => Math.abs(l[0]!.y - it.y) < LINE_TOLERANCE_PT);
        if (line) line.push(it);
        else lines.push([it]);
      }
      for (const l of lines) l.sort((a, b) => a.x - b.x);
      pages.push({ lines });
      page.cleanup();
    }
    return pages;
  } finally {
    await loadingTask.destroy();
  }
}

const MONTH_NAMES = [
  "", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Parse a Wells Fargo statement PDF into bank rows. Throws when the
 * file doesn't look like a statement (no statement date found).
 */
export async function parsePdfStatement(file: File): Promise<PdfStatementParse> {
  const pages = await extractPdfPages(file);
  const stmt = detectStatementDate(pages);
  if (!stmt) {
    throw new Error(
      `Could not find a statement date in "${file.name}". ` +
        `PDF import currently supports Wells Fargo checking/savings statements.`,
    );
  }
  const { rows, errors } = parseWellsFargoPdf(pages, {
    statementYear: stmt.year,
    statementMonth: stmt.month,
  });
  return {
    rows,
    errors,
    statementLabel: `${MONTH_NAMES[stmt.month]} ${stmt.year}`,
  };
}

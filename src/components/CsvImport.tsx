/**
 * CSV bank import UI (Phase A). Lives in Settings under "Bank import".
 * Pick files -> map each to an app account -> preview -> import.
 * Every import is one batch that can be rolled back from the history
 * list below.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getActiveDb } from "../data/db.js";
import { createRepositories } from "../data/repositories/index.js";
import type { Account } from "../domain/entities/account.js";
import type { BankAccountMap } from "../domain/entities/bankAccountMap.js";
import type { ImportBatch } from "../domain/entities/importBatch.js";
import type { AmountSignConvention } from "../domain/import/wellsFargoCsv.js";
import {
  commitCsvImport,
  previewCsvImport,
  rollbackImportBatch,
  suggestBankKey,
  type CsvFileInput,
  type ImportPreview,
} from "../app/csvImport.js";

function repos() {
  return createRepositories(getActiveDb());
}

const inputCls =
  "w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100";
const labelCls = "mb-1 block text-xs font-medium text-stone-500 dark:text-stone-400";
const primaryBtnCls =
  "rounded-full bg-stone-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200 disabled:opacity-60";
const secondaryBtnCls =
  "rounded-full border border-stone-200 px-4 py-2 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-50 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800 disabled:opacity-60";
const dangerBtnCls =
  "rounded-full border border-red-200 px-4 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950 disabled:opacity-60";

interface FileState {
  key: string;
  fileName: string;
  text: string;
  bankKey: string;
  appAccountId: string;
  sign: AmountSignConvention;
}

function money(minor: number): string {
  const sign = minor < 0 ? "−" : "+";
  return `${sign}$${(Math.abs(minor) / 100).toFixed(2)}`;
}

export function CsvImportSection() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [maps, setMaps] = useState<BankAccountMap[]>([]);
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [files, setFiles] = useState<FileState[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);
  const [confirmRollback, setConfirmRollback] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const r = repos();
    const [accts, m, b] = await Promise.all([
      r.accounts.getAll(),
      r.bankAccountMaps.getAll(),
      r.importBatches.getAll(),
    ]);
    setAccounts(accts.filter((a) => !a.archived));
    setMaps(m);
    setBatches([...b].sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1)));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mapFor = useCallback(
    (bankKey: string) => maps.find((m) => m.bankKey.toLowerCase() === bankKey.toLowerCase()),
    [maps],
  );

  const onPickFiles = useCallback(
    async (list: FileList | null) => {
      if (!list || list.length === 0) return;
      setError(null);
      setDoneMsg(null);
      setPreview(null);
      const read = (f: File) =>
        new Promise<string>((resolve, reject) => {
          const rd = new FileReader();
          rd.onload = () => resolve(String(rd.result ?? ""));
          rd.onerror = () => reject(new Error(`Could not read ${f.name}`));
          rd.readAsText(f);
        });
      const next: FileState[] = [];
      for (const f of Array.from(list)) {
        const text = await read(f).catch((e: Error) => {
          setError(e.message);
          return null;
        });
        if (text === null) continue;
        const bankKey = suggestBankKey(f.name);
        const mapped = mapFor(bankKey);
        next.push({
          key: `${Date.now()}-${f.name}`,
          fileName: f.name,
          text,
          bankKey,
          appAccountId: mapped?.appAccountId ?? accounts[0]?.id ?? "",
          sign: "negative-is-outflow",
        });
      }
      setFiles((prev) => [...prev, ...next]);
    },
    [accounts, mapFor],
  );

  const updateFile = (key: string, patch: Partial<FileState>) =>
    setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  const doPreview = useCallback(async () => {
    setError(null);
    setDoneMsg(null);
    if (files.some((f) => !f.appAccountId)) {
      setError("Pick an app account for every file first.");
      return;
    }
    setWorking(true);
    try {
      const inputs: CsvFileInput[] = files.map((f) => ({
        fileName: f.fileName,
        text: f.text,
        bankKey: f.bankKey.trim() || suggestBankKey(f.fileName),
        appAccountId: f.appAccountId,
        sign: f.sign,
      }));
      setPreview(await previewCsvImport(repos(), inputs));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preview failed.");
    } finally {
      setWorking(false);
    }
  }, [files]);

  const doCommit = useCallback(async () => {
    if (!preview) return;
    setError(null);
    setWorking(true);
    try {
      const inputs: CsvFileInput[] = files.map((f) => ({
        fileName: f.fileName,
        text: f.text,
        bankKey: f.bankKey.trim() || suggestBankKey(f.fileName),
        appAccountId: f.appAccountId,
        sign: f.sign,
      }));
      const { batch } = await commitCsvImport(repos(), preview, inputs);
      setDoneMsg(
        `Imported ${batch.stats.imported} transactions (${batch.stats.duplicates} duplicates skipped).`,
      );
      setFiles([]);
      setPreview(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setWorking(false);
    }
  }, [preview, files, load]);

  const doRollback = useCallback(
    async (batchId: string) => {
      setError(null);
      setWorking(true);
      try {
        const { deletedTransactions } = await rollbackImportBatch(repos(), batchId);
        setDoneMsg(`Rolled back: removed ${deletedTransactions} imported transactions.`);
        setConfirmRollback(null);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Rollback failed.");
      } finally {
        setWorking(false);
      }
    },
    [load],
  );

  const sampleRows = preview?.planned.filter((p) => !p.duplicate).slice(0, 8) ?? [];

  return (
    <div>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        multiple
        className="hidden"
        aria-label="Choose CSV files"
        onChange={(e) => {
          void onPickFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <button type="button" onClick={() => fileRef.current?.click()} className={secondaryBtnCls}>
        Choose CSV files
      </button>

      {files.length > 0 && (
        <div className="mt-4 space-y-3">
          {files.map((f) => (
            <div
              key={f.key}
              className="rounded-2xl border border-stone-200 p-3 dark:border-stone-700"
            >
              <p className="text-sm font-medium text-stone-900 dark:text-stone-100">{f.fileName}</p>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div>
                  <label className={labelCls} htmlFor={`bk-${f.key}`}>
                    Bank account label
                  </label>
                  <input
                    id={`bk-${f.key}`}
                    className={inputCls}
                    value={f.bankKey}
                    onChange={(e) => updateFile(f.key, { bankKey: e.target.value })}
                  />
                </div>
                <div>
                  <label className={labelCls} htmlFor={`ac-${f.key}`}>
                    App account
                  </label>
                  <select
                    id={`ac-${f.key}`}
                    className={inputCls}
                    value={f.appAccountId}
                    onChange={(e) => updateFile(f.key, { appAccountId: e.target.value })}
                  >
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls} htmlFor={`sg-${f.key}`}>
                    Amount sign
                  </label>
                  <select
                    id={`sg-${f.key}`}
                    className={inputCls}
                    value={f.sign}
                    onChange={(e) => updateFile(f.key, { sign: e.target.value as AmountSignConvention })}
                  >
                    <option value="negative-is-outflow">− = money out (checking/savings)</option>
                    <option value="negative-is-inflow">− = money in (some card exports)</option>
                  </select>
                </div>
              </div>
              {mapFor(f.bankKey.trim()) && (
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  Remembered: "{f.bankKey.trim()}" maps to{" "}
                  {accounts.find((a) => a.id === mapFor(f.bankKey.trim())?.appAccountId)?.name}.
                </p>
              )}
              <button
                type="button"
                className="mt-2 text-xs font-medium text-stone-500 underline dark:text-stone-400"
                onClick={() => setFiles((prev) => prev.filter((x) => x.key !== f.key))}
              >
                Remove file
              </button>
            </div>
          ))}
          <div className="flex gap-2">
            <button type="button" onClick={() => void doPreview()} disabled={working} className={primaryBtnCls}>
              {working ? "Working…" : "Preview import"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-3 text-sm text-red-700 dark:text-red-300">{error}</p>
      )}
      {doneMsg && (
        <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-300">{doneMsg}</p>
      )}

      {preview && (
        <div className="mt-4 rounded-2xl border border-stone-200 p-3 dark:border-stone-700">
          <p className="text-sm font-medium text-stone-900 dark:text-stone-100">Preview</p>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
            {preview.newCount} new · {preview.duplicateCount} duplicates skipped
          </p>
          {preview.files.map((f) => (
            <div key={f.fileName} className="mt-2 text-xs text-stone-500 dark:text-stone-400">
              <span className="font-medium text-stone-700 dark:text-stone-200">{f.fileName}</span>
              {" — "}
              {f.rows} rows
              {f.errors.map((e) => (
                <span key={e} className="block text-red-600 dark:text-red-400">
                  {e}
                </span>
              ))}
            </div>
          ))}
          {sampleRows.length > 0 && (
            <ul className="mt-2 divide-y divide-stone-100 text-sm dark:divide-stone-800">
              {sampleRows.map((p) => (
                <li key={p.fingerprint} className="flex items-baseline justify-between gap-2 py-1.5">
                  <span className="min-w-0">
                    <span className="block truncate text-stone-900 dark:text-stone-100">
                      {p.row.description}
                    </span>
                    <span className="text-xs text-stone-500 dark:text-stone-400">
                      {p.row.date} · {accounts.find((a) => a.id === p.accountId)?.name}
                    </span>
                  </span>
                  <span
                    className={`shrink-0 font-medium ${
                      p.row.amountMinor < 0
                        ? "text-stone-900 dark:text-stone-100"
                        : "text-emerald-700 dark:text-emerald-300"
                    }`}
                  >
                    {money(p.row.amountMinor)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={() => void doCommit()}
            disabled={working || preview.newCount === 0}
            className={`${primaryBtnCls} mt-3`}
          >
            {working ? "Working…" : `Import ${preview.newCount} transactions`}
          </button>
          {preview.newCount === 0 && (
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              Nothing new — every row was already imported.
            </p>
          )}
        </div>
      )}

      {batches.length > 0 && (
        <div className="mt-4">
          <p className="text-sm font-medium text-stone-900 dark:text-stone-100">Import history</p>
          <ul className="mt-2 space-y-2">
            {batches.map((b) => (
              <li
                key={b.id}
                className="flex items-center justify-between gap-2 rounded-2xl border border-stone-200 px-3 py-2 dark:border-stone-700"
              >
                <span className="min-w-0 text-sm">
                  <span className="block truncate text-stone-900 dark:text-stone-100">
                    {b.fileNames.join(", ")}
                  </span>
                  <span className="text-xs text-stone-500 dark:text-stone-400">
                    {b.stats.imported} imported · {b.stats.duplicates} duplicates
                    {b.status === "rolled-back" ? " · rolled back" : ""}
                  </span>
                </span>
                {b.status === "committed" &&
                  (confirmRollback === b.id ? (
                    <span className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        onClick={() => void doRollback(b.id)}
                        disabled={working}
                        className={dangerBtnCls}
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmRollback(null)}
                        className={secondaryBtnCls}
                      >
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmRollback(b.id)}
                      disabled={working}
                      className={`${secondaryBtnCls} shrink-0`}
                    >
                      Roll back
                    </button>
                  ))}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

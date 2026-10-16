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
  commitImport,
  planImport,
  type CommitSummary,
  type ImportPlan,
} from "../app/importEngine.js";
import { undoRecurringRule } from "../app/recurringDetect.js";
import { exportAll, exportJsonFile } from "../app/backup.js";
import { todayLocal } from "../domain/dates/dateOnly.js";
import { rollbackImportBatch, suggestBankKey, type CsvFileInput } from "../app/csvImport.js";
import { DEFAULT_SELF_NAME_VARIATIONS } from "../domain/import/selfTransfers.js";

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
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [summary, setSummary] = useState<CommitSummary | null>(null);
  const [statements, setStatements] = useState<Record<string, string>>({});
  // One-tap backup prompt shown after each successful import.
  const [backupState, setBackupState] = useState<"idle" | "working" | "done">("idle");
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
      setPlan(null);
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

  const toInputs = useCallback(
    (): CsvFileInput[] =>
      files.map((f) => ({
        fileName: f.fileName,
        text: f.text,
        bankKey: f.bankKey.trim() || suggestBankKey(f.fileName),
        appAccountId: f.appAccountId,
        sign: f.sign,
      })),
    [files],
  );

  const parseStatement = (v: string): number | null => {
    const n = Number(v.replace(/[$,\s]/g, ""));
    return v.trim() !== "" && Number.isFinite(n) ? Math.round(n * 100) : null;
  };

  const doPreview = useCallback(async () => {
    setError(null);
    setDoneMsg(null);
    setSummary(null);
    if (files.some((f) => !f.appAccountId)) {
      setError("Pick an app account for every file first.");
      return;
    }
    setWorking(true);
    try {
      setPlan(await planImport(repos(), toInputs()));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preview failed.");
    } finally {
      setWorking(false);
    }
  }, [files, toInputs]);

  const doCommit = useCallback(async () => {
    if (!plan) return;
    setError(null);
    setWorking(true);
    try {
      const statementBalances: Record<string, number> = {};
      for (const [accountId, v] of Object.entries(statements)) {
        const minor = parseStatement(v);
        if (minor !== null) statementBalances[accountId] = minor;
      }
      const result = await commitImport(
        repos(),
        plan,
        toInputs(),
        Object.keys(statementBalances).length > 0 ? statementBalances : undefined,
      );
      setSummary(result);
      setBackupState("idle");
      setFiles([]);
      setPlan(null);
      setStatements({});
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setWorking(false);
    }
  }, [plan, toInputs, statements, load]);

  const doBackup = useCallback(async () => {
    setBackupState("working");
    try {
      const data = await exportAll(repos());
      await exportJsonFile(`money-tracker-backup-${todayLocal()}.json`, data);
      setBackupState("done");
    } catch (e) {
      // Dismissing the share sheet is a cancel, not a failure: the export
      // already stamped lastBackupAt.
      if (e instanceof DOMException && e.name === "AbortError") {
        setBackupState("done");
      } else {
        setBackupState("idle");
      }
    }
  }, []);

  const doUndoRecurring = useCallback(
    async (ruleId: string) => {
      setError(null);
      setWorking(true);
      try {
        const { untagged } = await undoRecurringRule(repos(), ruleId);
        setSummary((s) =>
          s ? { ...s, recurring: { ...s.recurring, created: s.recurring.created.filter((c) => c.ruleId !== ruleId) } } : s,
        );
        setDoneMsg(`Undone — rule removed, ${untagged} past charges untagged. Transactions kept.`);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Undo failed.");
      } finally {
        setWorking(false);
      }
    },
    [load],
  );

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

  const sampleRows = plan?.preview.planned.filter((p) => !p.duplicate).slice(0, 8) ?? [];

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

      {plan && (
        <div className="mt-4 rounded-2xl border border-stone-200 p-3 dark:border-stone-700">
          <p className="text-sm font-medium text-stone-900 dark:text-stone-100">Preview</p>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
            {plan.summary.newRows} new · {plan.summary.matched} matched to your entries ·{" "}
            {plan.summary.billSettled} bills settled · {plan.summary.transfersNew} transfers ·{" "}
            {plan.summary.duplicates} duplicates skipped · {plan.summary.needsReview} need review
            {(plan.recurringPreview.wouldCreate > 0 ||
              plan.recurringPreview.wouldSuggest > 0 ||
              plan.recurringPreview.wouldEnd > 0) && (
              <>
                {" · "}
                {[
                  plan.recurringPreview.wouldCreate > 0 &&
                    `${plan.recurringPreview.wouldCreate} new bill${plan.recurringPreview.wouldCreate === 1 ? "" : "s"} detected`,
                  plan.recurringPreview.wouldEnd > 0 &&
                    `${plan.recurringPreview.wouldEnd} past subscription${plan.recurringPreview.wouldEnd === 1 ? "" : "s"}`,
                  plan.recurringPreview.wouldSuggest > 0 &&
                    `${plan.recurringPreview.wouldSuggest} possible subscription${plan.recurringPreview.wouldSuggest === 1 ? "" : "s"}`,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </>
            )}
          </p>
          {plan.preview.files.map((f) => (
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
          <div className="mt-3">
            <p className={labelCls}>Statement ending balances (optional — checks the app's math)</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {accounts.map((a) => (
                <div key={a.id} className="flex items-center gap-2">
                  <span className="w-32 shrink-0 truncate text-xs text-stone-500 dark:text-stone-400">
                    {a.name}
                  </span>
                  <input
                    className={inputCls}
                    placeholder="$0.00"
                    value={statements[a.id] ?? ""}
                    onChange={(e) => setStatements((s) => ({ ...s, [a.id]: e.target.value }))}
                    inputMode="decimal"
                    aria-label={`Statement balance for ${a.name}`}
                  />
                </div>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void doCommit()}
            disabled={working || plan.summary.newRows === 0}
            className={`${primaryBtnCls} mt-3`}
          >
            {working ? "Working…" : `Import ${plan.summary.newRows} transactions`}
          </button>
          {plan.summary.newRows === 0 && (
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              Nothing new — every row was already imported.
            </p>
          )}
        </div>
      )}

      {summary && summary.batch && (
        <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-950">
          <p className="text-sm font-medium text-emerald-900 dark:text-emerald-100">Import complete</p>
          <p className="mt-1 text-sm text-emerald-800 dark:text-emerald-200">
            {summary.imported + summary.transfersNew} imported · {summary.matched} matched ·{" "}
            {summary.billSettled} bills settled · {summary.needsReview} need review
            {summary.recurring.pastSubscriptions > 0 &&
              ` · Past subscriptions found: ${summary.recurring.pastSubscriptions}`}
          </p>
          {summary.recurring.created.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {summary.recurring.created.map((c) => (
                <li
                  key={c.ruleId}
                  className="flex items-center justify-between gap-2 text-sm text-emerald-800 dark:text-emerald-200"
                >
                  <span>{c.message}</span>
                  <button
                    type="button"
                    className={secondaryBtnCls}
                    disabled={working}
                    onClick={() => void doUndoRecurring(c.ruleId)}
                  >
                    Undo
                  </button>
                </li>
              ))}
            </ul>
          )}
          {summary.reconciliation.some((r) => r.diff !== undefined) && (
            <ul className="mt-2 space-y-1 text-sm">
              {summary.reconciliation
                .filter((r) => r.diff !== undefined)
                .map((r) => (
                  <li key={r.accountId} className="text-emerald-800 dark:text-emerald-200">
                    {r.accountName}: app {money(r.appBalance)} vs statement{" "}
                    {money(r.statementBalance as number)}
                    {r.diff !== 0 && (
                      <span className="font-medium"> — off by {money(r.diff as number)}</span>
                    )}
                  </li>
                ))}
            </ul>
          )}
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-emerald-200 pt-3 dark:border-emerald-800">
            <p className="text-sm text-emerald-800 dark:text-emerald-200">
              {backupState === "done" ? "Backed up." : "Keep a copy of your data safe."}
            </p>
            {backupState !== "done" && (
              <button
                type="button"
                onClick={() => void doBackup()}
                disabled={backupState === "working"}
                className={secondaryBtnCls}
              >
                {backupState === "working" ? "Working…" : "Export backup"}
              </button>
            )}
          </div>
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

      <SelfTransferSettings accounts={accounts} />
    </div>
  );
}

/** Name variations + bank account-label maps for self-transfer detection. */
function SelfTransferSettings({ accounts }: { accounts: Account[] }) {
  const [variations, setVariations] = useState<string[]>([]);
  const [labelMaps, setLabelMaps] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newLabelAccount, setNewLabelAccount] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const s = await repos().settings.get();
    setVariations(s?.selfNameVariations ?? DEFAULT_SELF_NAME_VARIATIONS);
    setLabelMaps(s?.transferAccountNameMaps ?? {});
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (patch: { selfNameVariations?: string[]; transferAccountNameMaps?: Record<string, string> }) => {
      const r = repos();
      const s = await r.settings.get();
      if (!s) {
        setMsg("Settings not found — open the app once first.");
        return;
      }
      await r.settings.save({ ...s, ...patch });
      await load();
      setMsg("Saved.");
      window.setTimeout(() => setMsg(null), 2000);
    },
    [load],
  );

  const plainLabelMaps = Object.entries(labelMaps).filter(([k]) => !k.startsWith("zelle:"));

  return (
    <div className="mt-4">
      <p className="text-sm font-medium text-stone-900 dark:text-stone-100">Self-transfer recognition</p>
      <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
        How the bank writes your name, and which account a bank label like "WAY2SAVE SAVINGS" means.
      </p>

      <p className={labelCls}>Name variations</p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {variations.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-700 dark:bg-stone-800 dark:text-stone-300"
          >
            {v}
            <button
              type="button"
              aria-label={`Remove ${v}`}
              className="text-stone-400 hover:text-stone-600 dark:hover:text-stone-200"
              onClick={() => void save({ selfNameVariations: variations.filter((x) => x !== v) })}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          className={inputCls}
          placeholder="Add a variation, e.g. SIDIBE MALIKE"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button
          type="button"
          className={secondaryBtnCls}
          onClick={() => {
            const v = newName.trim().toUpperCase();
            if (!v || variations.includes(v)) return;
            setNewName("");
            void save({ selfNameVariations: [...variations, v] });
          }}
        >
          Add
        </button>
      </div>

      <p className={labelCls}>Account labels</p>
      <ul className="mt-1 space-y-1.5">
        {plainLabelMaps.map(([label, accountId]) => (
          <li key={label} className="flex items-center gap-2">
            <span className="w-40 shrink-0 truncate text-xs text-stone-600 dark:text-stone-300">{label}</span>
            <select
              className={inputCls}
              value={accountId}
              onChange={(e) =>
                void save({ transferAccountNameMaps: { ...labelMaps, [label]: e.target.value } })
              }
              aria-label={`Account for ${label}`}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label={`Remove ${label}`}
              className={secondaryBtnCls}
              onClick={() => {
                const next = { ...labelMaps };
                delete next[label];
                void save({ transferAccountNameMaps: next });
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex gap-2">
        <input
          className={inputCls}
          placeholder="Label as the bank writes it"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
        />
        <select
          className={inputCls}
          value={newLabelAccount}
          onChange={(e) => setNewLabelAccount(e.target.value)}
          aria-label="App account"
        >
          <option value="">App account…</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={secondaryBtnCls}
          disabled={!newLabel.trim() || !newLabelAccount}
          onClick={() => {
            const label = newLabel.trim().toUpperCase();
            setNewLabel("");
            setNewLabelAccount("");
            void save({ transferAccountNameMaps: { ...labelMaps, [label]: newLabelAccount } });
          }}
        >
          Add
        </button>
      </div>
      {msg && <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{msg}</p>}
    </div>
  );
}

/**
 * Settings screen: appearance, base currency, safety buffer, categories,
 * backup (JSON export/import, CSV export), and bill notifications.
 *
 * Self-contained sheet: the coordinator renders
 * <SettingsSheet open={...} onClose={...} onChanged={reload} />.
 * Also exports BackupBanner, which the coordinator mounts on the dashboard.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createRepositories } from "../data/repositories/index.js";
import { getActiveDb } from "../data/db.js";
import type { Category, CategoryKind } from "../domain/entities/category.js";
import type { Settings as SettingsEntity } from "../domain/entities/settings.js";
import { applyTheme, type ThemeSetting } from "../app/theme.js";
import {
  exportJsonFile,
  exportTextFile,
  exportAll,
  importAll,
  markBackedUp,
  shouldRemindBackup,
  transactionsToCsv,
  validateBackup,
  type BackupData,
} from "../app/backup.js";
import { parseDollarsToMinor } from "../app/quickLog.js";
import { formatMoney } from "../app/format.js";
import { decimalsOf } from "../domain/money/currency.js";
import { todayLocal } from "../domain/dates/dateOnly.js";
import {
  getInboxToken,
  getInboxTokenExpiry,
  setInboxToken,
  setInboxTokenExpiry,
  validateInboxTokenSave,
} from "../utils/inbox.js";

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "CHF", "GNF"];

const THEME_OPTIONS: { id: ThemeSetting; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

function repos() {
  return createRepositories(getActiveDb());
}

function defaultSettings(): SettingsEntity {
  return {
    id: "settings",
    baseCurrency: "USD",
    bufferAmount: 0,
    theme: "system",
    notificationsEnabled: false,
    onboardingCompleted: false,
    lastBackupAt: undefined,
  };
}

const inputCls =
  "w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100";
const labelCls = "mb-1.5 block text-xs font-medium text-stone-500 dark:text-stone-400";
const primaryBtnCls =
  "rounded-full bg-stone-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200 disabled:opacity-60";
const secondaryBtnCls =
  "rounded-full border border-stone-200 px-4 py-2 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-50 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800";

function Section({ title, blurb, children }: { title: string; blurb: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-stone-100 pt-5 dark:border-stone-800">
      <h3 className="font-display text-lg text-stone-900 dark:text-stone-100">{title}</h3>
      <p className="mt-0.5 text-sm text-stone-500 dark:text-stone-400">{blurb}</p>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  );
}

function formatLastBackup(lastBackupAt: string | undefined): string {
  if (!lastBackupAt) return "Never";
  const d = new Date(lastBackupAt);
  if (Number.isNaN(d.getTime())) return "Never";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** "It's been a while" banner. The coordinator mounts it on the dashboard. */
export function BackupBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const s = await repos().settings.get();
      if (alive) setVisible(shouldRemindBackup(s?.lastBackupAt, new Date().toISOString()));
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!visible) return null;
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl bg-amber-50 px-4 py-3 ring-1 ring-inset ring-amber-200 dark:bg-amber-950 dark:ring-amber-800">
      <p className="text-sm text-amber-800 dark:text-amber-200">
        It&rsquo;s been a while since your last backup.
      </p>
      <button
        type="button"
        onClick={onOpenSettings}
        className="shrink-0 rounded-full bg-stone-900 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200"
      >
        Back up now
      </button>
    </div>
  );
}

type ImportState =
  | { stage: "idle" }
  | { stage: "errors"; errors: string[]; fileName: string }
  | { stage: "confirm"; data: BackupData; fileName: string }
  | { stage: "working" }
  | { stage: "done" }
  | { stage: "failed"; message: string };

export function SettingsSheet({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [settings, setSettings] = useState<SettingsEntity | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [bufferText, setBufferText] = useState("");
  const [bufferSaved, setBufferSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importState, setImportState] = useState<ImportState>({ stage: "idle" });
  const [exporting, setExporting] = useState(false);
  const [notifNote, setNotifNote] = useState<string | null>(null);
  // Private inbox token: localStorage only, never IndexedDB, so it can't
  // leak into a JSON backup export.
  const [inboxTokenText, setInboxTokenText] = useState("");
  const [inboxTokenExpiryText, setInboxTokenExpiryText] = useState("");
  const [inboxSaved, setInboxSaved] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [newCatName, setNewCatName] = useState("");
  const [newCatKind, setNewCatKind] = useState<CategoryKind>("expense");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, cats] = await Promise.all([repos().settings.get(), repos().categories.getAll()]);
      const merged = { ...defaultSettings(), ...s };
      setSettings(merged);
      setCategories(cats);
    } catch {
      setError("Settings did not load. Close and try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setImportState({ stage: "idle" });
      setNotifNote(null);
      setBufferSaved(false);
      setInboxSaved(false);
      setInboxError(null);
      setInboxTokenText(getInboxToken() ?? "");
      setInboxTokenExpiryText(getInboxTokenExpiry() ?? "");
      void load();
    }
  }, [open, load]);

  const saveInboxToken = () => {
    setInboxError(null);
    const problem = validateInboxTokenSave(inboxTokenText, inboxTokenExpiryText);
    if (problem !== null) {
      setInboxError(problem);
      return;
    }
    const expiryRaw = inboxTokenExpiryText.trim();
    setInboxToken(inboxTokenText);
    setInboxTokenExpiry(expiryRaw === "" ? null : expiryRaw);
    setInboxSaved(true);
  };

  // Keep the buffer editor in sync when settings arrive.
  useEffect(() => {
    if (settings && bufferText === "" && !bufferSaved) {
      let d = 2;
      try {
        d = decimalsOf(settings.baseCurrency);
      } catch {
        d = 2;
      }
      setBufferText(settings.bufferAmount === 0 ? "" : (settings.bufferAmount / 10 ** d).toFixed(d));
    }
    // Only seed the editor from loaded settings, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const saveSettings = useCallback(
    async (next: SettingsEntity) => {
      setSettings(next);
      await repos().settings.save(next);
    },
    [],
  );

  const setTheme = async (theme: ThemeSetting) => {
    if (!settings) return;
    const next = { ...settings, theme };
    await saveSettings(next);
    applyTheme(theme);
  };

  const setBaseCurrency = async (baseCurrency: string) => {
    if (!settings || baseCurrency === settings.baseCurrency) return;
    await saveSettings({ ...settings, baseCurrency });
    onChanged();
  };

  const saveBuffer = async () => {
    if (!settings) return;
    setError(null);
    const trimmed = bufferText.trim();
    if (trimmed === "") {
      await saveSettings({ ...settings, bufferAmount: 0 });
      setBufferSaved(true);
      onChanged();
      return;
    }
    let minor: number | null;
    try {
      minor = parseDollarsToMinor(trimmed, settings.baseCurrency);
    } catch {
      setError("That amount did not parse. Try something like 50.00.");
      return;
    }
    if (minor === null) {
      setError("That amount did not parse. Try something like 50.00.");
      return;
    }
    await saveSettings({ ...settings, bufferAmount: minor });
    setBufferSaved(true);
    onChanged();
  };

  const toggleNotifications = async () => {
    if (!settings) return;
    setNotifNote(null);
    const turningOn = !settings.notificationsEnabled;
    if (!turningOn) {
      await saveSettings({ ...settings, notificationsEnabled: false });
      return;
    }
    if (typeof Notification === "undefined") {
      setNotifNote("This browser does not do notifications.");
      return;
    }
    let permission = Notification.permission;
    if (permission === "default") {
      try {
        permission = await Notification.requestPermission();
      } catch {
        permission = "denied";
      }
    }
    if (permission === "granted") {
      await saveSettings({ ...settings, notificationsEnabled: true });
      setNotifNote("On. You will see a reminder when bills are due soon.");
    } else {
      await saveSettings({ ...settings, notificationsEnabled: false });
      setNotifNote("Notifications are blocked. Allow them in the browser settings, then try again.");
    }
  };

  const addCategory = async () => {
    const name = newCatName.trim();
    if (name === "") return;
    const cat: Category = {
      id: crypto.randomUUID(),
      name,
      kind: newCatKind,
      icon: "dots",
      color: "slate",
      archived: false,
    };
    await repos().categories.put(cat);
    setCategories((cs) => [...cs, cat]);
    setNewCatName("");
    onChanged();
  };

  const startRename = (cat: Category) => {
    setEditingId(cat.id);
    setEditingName(cat.name);
  };

  const saveRename = async () => {
    const name = editingName.trim();
    if (!editingId || name === "") {
      setEditingId(null);
      return;
    }
    const cat = categories.find((c) => c.id === editingId);
    if (cat && cat.name !== name) {
      const next = { ...cat, name };
      await repos().categories.put(next);
      setCategories((cs) => cs.map((c) => (c.id === editingId ? next : c)));
      onChanged();
    }
    setEditingId(null);
  };

  const setArchived = async (cat: Category, archived: boolean) => {
    const next = { ...cat, archived };
    await repos().categories.put(next);
    setCategories((cs) => cs.map((c) => (c.id === cat.id ? next : c)));
    onChanged();
  };

  const doExportJson = async () => {
    setError(null);
    setExporting(true);
    try {
      const data = await exportAll(repos());
      await exportJsonFile(`money-tracker-backup-${todayLocal()}.json`, data);
      const s = await repos().settings.get();
      if (s) setSettings({ ...defaultSettings(), ...s });
    } catch (e) {
      // Dismissing the share sheet is a cancel, not a failure.
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError("The export failed. Try again.");
      }
    } finally {
      setExporting(false);
    }
  };

  const doExportCsv = async () => {
    setError(null);
    setExporting(true);
    try {
      const r = repos();
      const [transactions, accounts, cats] = await Promise.all([
        r.transactions.getAll(),
        r.accounts.getAll(),
        r.categories.getAll(),
      ]);
      const csv = transactionsToCsv(
        [...transactions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
        new Map(accounts.map((a) => [a.id, a])),
        new Map(cats.map((c) => [c.id, c])),
      );
      await exportTextFile(`money-tracker-transactions-${todayLocal()}.csv`, csv, "text/csv");
      await markBackedUp(r, new Date().toISOString());
      const s = await r.settings.get();
      if (s) setSettings({ ...defaultSettings(), ...s });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError("The export failed. Try again.");
      }
    } finally {
      setExporting(false);
    }
  };

  const onPickFile = async (file: File) => {
    setImportState({ stage: "working" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setImportState({
        stage: "errors",
        fileName: file.name,
        errors: ["This file is not valid JSON."],
      });
      return;
    }
    const result = validateBackup(parsed);
    if (!result.ok) {
      setImportState({ stage: "errors", fileName: file.name, errors: result.errors });
      return;
    }
    setImportState({ stage: "confirm", data: result.data, fileName: file.name });
  };

  const doImport = async () => {
    if (importState.stage !== "confirm") return;
    setImportState({ stage: "working" });
    try {
      await importAll(repos(), importState.data);
      setImportState({ stage: "done" });
      onChanged();
    } catch {
      setImportState({ stage: "failed", message: "The import failed partway. Your old data may be incomplete. Export a backup right away if you have a good file." });
    }
  };

  if (!open) return null;

  const sortedCats = [...categories].sort((a, b) =>
    a.archived !== b.archived ? (a.archived ? 1 : -1) : a.name.localeCompare(b.name),
  );

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Settings">
      <button type="button" aria-label="Close settings" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div className="absolute bottom-0 inset-x-0 mx-auto max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 pb-10 dark:bg-stone-900">
        <div className="flex items-start justify-between">
          <h2 className="font-display text-xl text-stone-900 dark:text-stone-100">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-full text-lg text-stone-500 transition-colors hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800"
          >
            ×
          </button>
        </div>

        {loading ? (
          <p className="py-8 text-center text-sm text-stone-500 dark:text-stone-400">Loading…</p>
        ) : error && !settings ? (
          <p className="py-8 text-center text-sm text-red-700 dark:text-red-300">{error}</p>
        ) : (
          settings && (
            <div className="mt-2 flex flex-col gap-6">
              {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}

              <Section title="Appearance" blurb="Pick how the app looks. System follows your phone.">
                <div
                  role="group"
                  aria-label="Theme"
                  className="grid grid-cols-3 gap-1 rounded-full bg-stone-100 p-1 dark:bg-stone-800"
                >
                  {THEME_OPTIONS.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => void setTheme(o.id)}
                      aria-pressed={settings.theme === o.id}
                      className={`rounded-full py-2 text-sm font-medium transition-colors ${
                        settings.theme === o.id
                          ? "bg-white text-stone-900 shadow-sm dark:bg-stone-900 dark:text-stone-100"
                          : "text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-300"
                      }`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </Section>

              <Section title="Base currency" blurb="Used for totals across the app.">
                <select
                  aria-label="Base currency"
                  value={settings.baseCurrency}
                  onChange={(e) => void setBaseCurrency(e.target.value)}
                  className={inputCls}
                >
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Section>

              <Section
                title="Safety buffer"
                blurb="Money the app pretends is already spent. It lowers your safe to spend number."
              >
                <div className="flex gap-2">
                  <input
                    aria-label="Safety buffer amount"
                    value={bufferText}
                    onChange={(e) => {
                      setBufferText(e.target.value);
                      setBufferSaved(false);
                    }}
                    inputMode="decimal"
                    placeholder="0.00"
                    className={inputCls}
                  />
                  <button type="button" onClick={() => void saveBuffer()} className={primaryBtnCls}>
                    Save
                  </button>
                </div>
                <p className="text-xs text-stone-500 dark:text-stone-400">
                  Current buffer: {formatMoney(settings.bufferAmount, settings.baseCurrency)}
                </p>
                {bufferSaved && (
                  <p className="text-xs text-emerald-700 dark:text-emerald-300">Saved.</p>
                )}
              </Section>

              <Section
                title="Categories"
                blurb="Rename them or archive the ones you never use. Archived ones stay on old transactions."
              >
                <ul className="flex flex-col divide-y divide-stone-100 dark:divide-stone-800">
                  {sortedCats.map((cat) => (
                    <li key={cat.id} className="flex items-center gap-2 py-2.5">
                      {editingId === cat.id ? (
                        <>
                          <input
                            aria-label="Category name"
                            value={editingName}
                            onChange={(e) => setEditingName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void saveRename();
                              if (e.key === "Escape") setEditingId(null);
                            }}
                            autoFocus
                            className={inputCls}
                          />
                          <button type="button" onClick={() => void saveRename()} className={secondaryBtnCls}>
                            Save
                          </button>
                        </>
                      ) : (
                        <>
                          <div className="min-w-0 flex-1">
                            <p
                              className={`truncate text-sm font-medium ${
                                cat.archived
                                  ? "text-stone-400 dark:text-stone-500"
                                  : "text-stone-900 dark:text-stone-100"
                              }`}
                            >
                              {cat.name}
                            </p>
                            <p className="text-xs capitalize text-stone-500 dark:text-stone-400">
                              {cat.kind}
                              {cat.archived ? " · archived" : ""}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => startRename(cat)}
                            className="rounded-full px-3 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800"
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            onClick={() => void setArchived(cat, !cat.archived)}
                            className="rounded-full px-3 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800"
                          >
                            {cat.archived ? "Restore" : "Archive"}
                          </button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2">
                  <input
                    aria-label="New category name"
                    value={newCatName}
                    onChange={(e) => setNewCatName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void addCategory();
                    }}
                    placeholder="New category"
                    className={inputCls}
                  />
                  <select
                    aria-label="New category type"
                    value={newCatKind}
                    onChange={(e) => setNewCatKind(e.target.value as CategoryKind)}
                    className="shrink-0 rounded-xl border border-stone-200 bg-white px-2 py-2.5 text-sm text-stone-900 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
                  >
                    <option value="expense">Expense</option>
                    <option value="income">Income</option>
                  </select>
                  <button type="button" onClick={() => void addCategory()} disabled={newCatName.trim() === ""} className={primaryBtnCls}>
                    Add
                  </button>
                </div>
              </Section>

              <Section
                title="Backup"
                blurb="Your data lives only on this device. Export a copy now and then so a lost phone is not a lost history."
              >
                <p className="text-xs text-stone-500 dark:text-stone-400">
                  Last backup: {formatLastBackup(settings.lastBackupAt)}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => void doExportJson()} disabled={exporting} className={primaryBtnCls}>
                    {exporting ? "Working…" : "Back up"}
                  </button>
                  <button type="button" onClick={() => void doExportCsv()} disabled={exporting} className={secondaryBtnCls}>
                    Export transactions CSV
                  </button>
                  <button type="button" onClick={() => fileRef.current?.click()} className={secondaryBtnCls}>
                    Import backup
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    aria-label="Choose a backup file"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f) void onPickFile(f);
                    }}
                  />
                </div>

                {importState.stage === "working" && (
                  <p className="text-sm text-stone-500 dark:text-stone-400">Working…</p>
                )}
                {importState.stage === "errors" && (
                  <div className="rounded-2xl bg-red-50 p-4 ring-1 ring-inset ring-red-200 dark:bg-red-950 dark:ring-red-800">
                    <p className="text-sm font-medium text-red-700 dark:text-red-300">
                      This file did not import. Nothing was changed.
                    </p>
                    <ul className="mt-2 flex max-h-48 flex-col gap-1 overflow-y-auto text-xs text-red-700 dark:text-red-300">
                      {importState.errors.map((msg, i) => (
                        <li key={i}>· {msg}</li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      onClick={() => setImportState({ stage: "idle" })}
                      className={`mt-3 ${secondaryBtnCls}`}
                    >
                      Pick another file
                    </button>
                  </div>
                )}
                {importState.stage === "confirm" && (
                  <div className="rounded-2xl bg-amber-50 p-4 ring-1 ring-inset ring-amber-200 dark:bg-amber-950 dark:ring-amber-800">
                    <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                      Import &ldquo;{importState.fileName}&rdquo;?
                    </p>
                    <p className="mt-1 text-sm text-amber-800 dark:text-amber-200">
                      This will replace all current data. This cannot be undone. Export a backup
                      first if you are not sure.
                    </p>
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() => void doImport()}
                        className="rounded-full bg-red-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-red-500 dark:bg-red-500 dark:hover:bg-red-400"
                      >
                        Replace all my data
                      </button>
                      <button
                        type="button"
                        onClick={() => setImportState({ stage: "idle" })}
                        className={secondaryBtnCls}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {importState.stage === "done" && (
                  <p className="text-sm text-emerald-700 dark:text-emerald-300">
                    Import complete. Your data is back.
                  </p>
                )}
                {importState.stage === "failed" && (
                  <p className="text-sm text-red-700 dark:text-red-300">{importState.message}</p>
                )}
              </Section>

              <Section
                title="Notifications"
                blurb="Works when the app is opened. No push server."
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
                    Bill reminders
                  </p>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={settings.notificationsEnabled}
                    aria-label="Bill reminders"
                    onClick={() => void toggleNotifications()}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                      settings.notificationsEnabled ? "bg-stone-900 dark:bg-stone-100" : "bg-stone-300 dark:bg-stone-600"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all dark:bg-stone-900 ${
                        settings.notificationsEnabled ? "left-[22px]" : "left-0.5"
                      }`}
                    />
                  </button>
                </div>
                {notifNote && (
                  <p className="text-xs text-stone-500 dark:text-stone-400">{notifNote}</p>
                )}
              </Section>

              <Section
                title="Inbox"
                blurb="Lets Rocky send spending entries to a private inbox you approve here. The token never leaves this phone and is never included in backups."
              >
                <label className={labelCls} htmlFor="inbox-token">
                  Inbox token (paste once)
                </label>
                <input
                  id="inbox-token"
                  type="password"
                  autoComplete="off"
                  value={inboxTokenText}
                  onChange={(e) => {
                    setInboxTokenText(e.target.value);
                    setInboxSaved(false);
                  }}
                  placeholder="github_pat_…"
                  className={inputCls}
                />
                <div className="mt-3">
                  <label className={labelCls} htmlFor="inbox-token-expiry">
                    Token expiry date
                  </label>
                  <input
                    id="inbox-token-expiry"
                    type="date"
                    value={inboxTokenExpiryText}
                    onChange={(e) => {
                      setInboxTokenExpiryText(e.target.value);
                      setInboxSaved(false);
                    }}
                    className={inputCls}
                  />
                </div>
                {inboxError && (
                  <p className="mt-2 text-xs font-medium text-red-700 dark:text-red-300">
                    {inboxError}
                  </p>
                )}
                <div className="mt-3 flex items-center gap-3">
                  <button type="button" onClick={saveInboxToken} className={primaryBtnCls}>
                    Save inbox token
                  </button>
                  {inboxTokenText.trim() === "" && getInboxToken() && (
                    <button
                      type="button"
                      onClick={() => {
                        setInboxToken("");
                        setInboxTokenExpiry(null);
                        setInboxSaved(true);
                      }}
                      className={secondaryBtnCls}
                    >
                      Remove
                    </button>
                  )}
                </div>
                {inboxSaved && (
                  <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">Saved.</p>
                )}
              </Section>
            </div>
          )
        )}
      </div>
    </div>
  );
}

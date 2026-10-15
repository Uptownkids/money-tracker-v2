/**
 * Accounts: the account list grouped Spendable / Savings / Owed (same
 * grouping rule as BalancesList), with add and edit sheets. Accounts are
 * archived, never deleted.
 */
import { useCallback, useEffect, useState } from "react";
import { createRepositories } from "../data/repositories/index.js";
import { getActiveDb } from "../data/db.js";
import {
  defaultCountsAsSpendable,
  isLiabilityAccount,
  toStoredBalance,
} from "../domain/entities/account.js";
import type { Account, AccountType } from "../domain/entities/account.js";
import { deriveBalances } from "../domain/engine/balances.js";
import { parseDollarsToMinor } from "../app/quickLog.js";
import { formatMoney } from "../app/format.js";
import { todayLocal } from "../domain/dates/dateOnly.js";
import type { MinorUnits } from "../domain/money/money.js";

const ACCOUNT_TYPES: AccountType[] = [
  "Checking",
  "Savings",
  "Cash",
  "CreditCard",
  "Loan",
  "Other",
];

const TYPE_LABEL: Record<AccountType, string> = {
  Checking: "Checking",
  Savings: "Savings",
  Cash: "Cash",
  CreditCard: "Credit card",
  Loan: "Loan",
  Other: "Account",
};

const fieldCls =
  "w-full rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-3.5 py-2.5 text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 focus:border-stone-400 dark:focus:border-stone-500 focus:outline-none";
const labelCls = "mb-1.5 block text-xs font-medium text-stone-500 dark:text-stone-400";

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
        checked ? "bg-stone-900 dark:bg-stone-100" : "bg-stone-300 dark:bg-stone-600"
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white dark:bg-stone-900 shadow transition-all ${
          checked ? "left-[22px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

function SheetShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div className="absolute bottom-0 inset-x-0 mx-auto max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white dark:bg-stone-900 p-5 pb-8">
        <div className="flex items-start justify-between">
          <h2 className="font-display text-xl text-stone-900 dark:text-stone-100">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-full text-lg text-stone-500 dark:text-stone-400 transition-colors hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function AddAccountSheet({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("Checking");
  const [starting, setStarting] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [currencyTouched, setCurrencyTouched] = useState(false);
  const [spendable, setSpendable] = useState(defaultCountsAsSpendable("Checking"));
  const [spendableTouched, setSpendableTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Default the new account's currency to the user's base currency.
  useEffect(() => {
    if (currencyTouched) return;
    let alive = true;
    void createRepositories(getActiveDb())
      .settings.get()
      .then((s) => {
        if (alive && s?.baseCurrency) setCurrency(s.baseCurrency);
      });
    return () => {
      alive = false;
    };
  }, [currencyTouched]);

  const liability = type === "CreditCard" || type === "Loan";

  const changeType = (t: AccountType) => {
    setType(t);
    if (!spendableTouched) setSpendable(defaultCountsAsSpendable(t));
  };

  const save = async () => {
    setError(null);
    const trimmed = name.trim();
    if (trimmed === "") {
      setError("Give the account a name.");
      return;
    }
    const code = currency.trim().toUpperCase() || "USD";
    let minor: MinorUnits | null;
    try {
      minor = parseDollarsToMinor(starting, code);
    } catch {
      setError("Unknown currency code — use a 3-letter code like USD.");
      return;
    }
    if (minor === null) {
      setError("Enter an amount like 12.34");
      return;
    }
    setSaving(true);
    try {
      const now = new Date().toISOString();
      const repos = createRepositories(getActiveDb());
      await repos.accounts.put({
        id: crypto.randomUUID(),
        name: trimmed,
        type,
        currency: code,
        startingBalance: toStoredBalance(type, minor),
        startingDate: todayLocal(),
        countsAsSpendable: spendable,
        archived: false,
        createdAt: now,
        updatedAt: now,
      });
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
      setSaving(false);
    }
  };

  return (
    <SheetShell title="Add account" onClose={onClose}>
      <div className="mt-4 flex flex-col gap-4">
        <div>
          <label htmlFor="aa-name" className={labelCls}>
            Name
          </label>
          <input
            id="aa-name"
            type="text"
            placeholder="Everyday checking"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={fieldCls}
          />
        </div>

        <div>
          <label htmlFor="aa-type" className={labelCls}>
            Type
          </label>
          <select
            id="aa-type"
            value={type}
            onChange={(e) => changeType(e.target.value as AccountType)}
            className={fieldCls}
          >
            {ACCOUNT_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="aa-starting" className={labelCls}>
            Starting balance
          </label>
          <input
            id="aa-starting"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={starting}
            onChange={(e) => setStarting(e.target.value)}
            className={`${fieldCls} font-display text-2xl`}
          />
          {liability && (
            <p className="pt-1.5 text-xs text-stone-500 dark:text-stone-400">
              Enter what you owe as a positive number.
            </p>
          )}
        </div>

        <div>
          <label htmlFor="aa-currency" className={labelCls}>
            Currency
          </label>
          <input
            id="aa-currency"
            type="text"
            value={currency}
            onChange={(e) => {
              setCurrencyTouched(true);
              setCurrency(e.target.value);
            }}
            className={fieldCls}
            maxLength={3}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-stone-900 dark:text-stone-100">Counts as spendable</p>
            <p className="text-xs text-stone-500 dark:text-stone-400">
              Spendable accounts feed the safe-to-spend number.
            </p>
          </div>
          <Toggle
            checked={spendable}
            onChange={(v) => {
              setSpendable(v);
              setSpendableTouched(true);
            }}
            label="Counts as spendable"
          />
        </div>

        {error && <p className="text-sm font-medium text-red-700 dark:text-red-300">{error}</p>}

        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-full bg-stone-900 dark:bg-stone-100 py-3 text-sm font-medium text-white dark:text-stone-900 transition-colors hover:bg-stone-700 dark:hover:bg-stone-200 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </SheetShell>
  );
}

function EditAccountSheet({
  account,
  onClose,
  onSaved,
}: {
  account: Account;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(account.name);
  const [spendable, setSpendable] = useState(account.countsAsSpendable);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const persist = async (archived: boolean) => {
    setError(null);
    const trimmed = name.trim();
    if (trimmed === "") {
      setError("Give the account a name.");
      return;
    }
    setSaving(true);
    try {
      const repos = createRepositories(getActiveDb());
      await repos.accounts.put({
        ...account,
        name: trimmed,
        countsAsSpendable: spendable,
        archived,
        updatedAt: new Date().toISOString(),
      });
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
      setSaving(false);
    }
  };

  return (
    <SheetShell title="Edit account" onClose={onClose}>
      <div className="mt-4 flex flex-col gap-4">
        <div>
          <label htmlFor="ea-name" className={labelCls}>
            Name
          </label>
          <input
            id="ea-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={fieldCls}
          />
        </div>

        <div>
          <p className="text-sm font-medium text-stone-900 dark:text-stone-100">{TYPE_LABEL[account.type]}</p>
          <p className="text-xs text-stone-500 dark:text-stone-400">{account.currency}</p>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-stone-900 dark:text-stone-100">Counts as spendable</p>
            <p className="text-xs text-stone-500 dark:text-stone-400">
              Spendable accounts feed the safe-to-spend number.
            </p>
          </div>
          <Toggle checked={spendable} onChange={setSpendable} label="Counts as spendable" />
        </div>

        {error && <p className="text-sm font-medium text-red-700 dark:text-red-300">{error}</p>}

        <button
          type="button"
          onClick={() => void persist(account.archived)}
          disabled={saving}
          className="rounded-full bg-stone-900 dark:bg-stone-100 py-3 text-sm font-medium text-white dark:text-stone-900 transition-colors hover:bg-stone-700 dark:hover:bg-stone-200 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => void persist(!account.archived)}
          disabled={saving}
          className="py-1 text-sm font-medium text-stone-600 dark:text-stone-400"
        >
          {account.archived ? "Unarchive account" : "Archive account"}
        </button>
      </div>
    </SheetShell>
  );
}

export function Accounts({ onChanged }: { onChanged: () => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);

  const load = useCallback(async () => {
    const repos = createRepositories(getActiveDb());
    const [accts, txs] = await Promise.all([
      repos.accounts.getAll(),
      repos.transactions.getAll(),
    ]);
    setAccounts(accts);
    setBalances(deriveBalances(accts, txs));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const afterWrite = useCallback(async () => {
    await load();
    onChanged();
  }, [load, onChanged]);

  const active = accounts.filter((a) => !a.archived);
  const archived = accounts.filter((a) => a.archived);
  const spendable = active.filter((a) => a.countsAsSpendable);
  const savings = active.filter((a) => !a.countsAsSpendable && !isLiabilityAccount(a));
  const owed = active.filter((a) => isLiabilityAccount(a));

  const Row = ({ account }: { account: Account }) => {
    const balance = balances[account.id] ?? 0;
    const isOwed = isLiabilityAccount(account);
    return (
      <button
        type="button"
        onClick={() => setEditing(account)}
        className="flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left transition-colors hover:bg-stone-50 dark:hover:bg-stone-800"
      >
        <div>
          <p className="text-sm font-medium text-stone-900 dark:text-stone-100">{account.name}</p>
          <p className="text-xs text-stone-500 dark:text-stone-400">
            {isOwed ? "Owed" : TYPE_LABEL[account.type]}
          </p>
        </div>
        <p
          className={`font-display text-xl ${isOwed ? "text-stone-500 dark:text-stone-400" : "text-stone-900 dark:text-stone-100"}`}
        >
          {isOwed && balance < 0
            ? `−${formatMoney(-balance, account.currency)}`
            : formatMoney(balance, account.currency)}
        </p>
      </button>
    );
  };

  const Group = ({ title, items }: { title: string; items: Account[] }) =>
    items.length === 0 ? null : (
      <div className="pt-2">
        <p className="px-4 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400">
          {title}
        </p>
        <div className="divide-y divide-stone-100 dark:divide-stone-800">
          {items.map((a) => (
            <Row key={a.id} account={a} />
          ))}
        </div>
      </div>
    );

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-stone-300 dark:border-stone-600 border-t-stone-800 dark:border-t-stone-200" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-3xl border border-stone-200/70 dark:border-stone-700 bg-white dark:bg-stone-900 px-2 py-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <div className="flex items-center justify-between px-4 pb-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400">
            Accounts
          </p>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="rounded-full bg-stone-900 dark:bg-stone-100 px-3.5 py-1.5 text-xs font-medium text-white dark:text-stone-900 transition-colors hover:bg-stone-700 dark:hover:bg-stone-200"
          >
            Add account
          </button>
        </div>
        <Group title="Spendable" items={spendable} />
        <Group title="Savings" items={savings} />
        <Group title="Owed" items={owed} />
        {archived.length > 0 && (
          <div className="pt-2 opacity-60">
            <p className="px-4 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400">
              Archived
            </p>
            <div className="divide-y divide-stone-100 dark:divide-stone-800">
              {archived.map((a) => (
                <Row key={a.id} account={a} />
              ))}
            </div>
          </div>
        )}
      </section>

      {addOpen && (
        <AddAccountSheet
          onClose={() => setAddOpen(false)}
          onSaved={async () => {
            setAddOpen(false);
            await afterWrite();
          }}
        />
      )}

      {editing && (
        <EditAccountSheet
          key={editing.id}
          account={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await afterWrite();
          }}
        />
      )}
    </div>
  );
}

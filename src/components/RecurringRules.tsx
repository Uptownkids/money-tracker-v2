/**
 * RecurringRules: the Phase 5 "Bills" area — manages recurring rules
 * (bills, subscriptions, paydays). Rows are filterable by kind, show
 * status badges (Active / Paused / Ended), and support pause/resume,
 * end (confirm, future occurrences stop via the engine's endDate
 * handling), primary-payday switching, annual-cost display and the
 * Unused/Cancel toggle for subscriptions. A bottom sheet (QuickLog
 * styling) creates and edits rules.
 */
import { useEffect, useRef, useState } from "react";
import { createRepositories } from "../data/repositories/index.js";
import { getActiveDb } from "../data/db.js";
import {
  annualCost,
  enumerateOccurrences,
  setPrimaryPayday,
} from "../domain/engine/recurringEngine.js";
import {
  addDays,
  compareDateOnly,
  isDateOnly,
  todayLocal,
} from "../domain/dates/dateOnly.js";
import type { DateOnly, WeekendShift } from "../domain/dates/dateOnly.js";
import type {
  Frequency,
  RecurringKind,
  RecurringRule,
} from "../domain/entities/recurringRule.js";
import { parseDollarsToMinor } from "../app/quickLog.js";
import { formatMoney } from "../app/format.js";
import { decimalsOf } from "../domain/money/currency.js";
import type { Account } from "../domain/entities/account.js";
import type { Category } from "../domain/entities/category.js";
import { expenseCategories } from "../domain/entities/category.js";
import type { MinorUnits } from "../domain/money/money.js";

const fieldCls =
  "w-full rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-3.5 py-2.5 text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 focus:border-stone-400 dark:focus:border-stone-500 focus:outline-none";
const labelCls = "mb-1.5 block text-xs font-medium text-stone-500 dark:text-stone-400";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const prettyDate = (d: DateOnly): string =>
  `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}`;

const TABS: { kind: RecurringKind; label: string }[] = [
  { kind: "Bill", label: "Bills" },
  { kind: "Subscription", label: "Subscriptions" },
  { kind: "Income", label: "Paydays" },
];

const KIND_LABEL: Record<RecurringKind, string> = {
  Bill: "Bill",
  Subscription: "Subscription",
  Income: "Payday",
};

const FREQUENCIES: Frequency[] = ["weekly", "biweekly", "semi-monthly", "monthly", "annual", "custom"];

const FREQUENCY_LABEL: Record<Frequency, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  "semi-monthly": "Twice a month",
  monthly: "Monthly",
  annual: "Yearly",
  custom: "Custom",
};

const WEEKEND_SHIFTS: WeekendShift[] = ["none", "previous-business-day", "next-business-day"];

const WEEKEND_SHIFT_LABEL: Record<WeekendShift, string> = {
  none: "None",
  "previous-business-day": "Previous business day",
  "next-business-day": "Next business day",
};

type RuleStatus = "Active" | "Paused" | "Ended";

function statusOf(rule: RecurringRule, today: DateOnly): RuleStatus {
  if (rule.endDate !== undefined && compareDateOnly(rule.endDate, today) <= 0) return "Ended";
  return rule.active ? "Active" : "Paused";
}

function frequencyLabel(rule: RecurringRule): string {
  if (rule.frequency === "custom") {
    return rule.customIntervalDays ? `Every ${rule.customIntervalDays} days` : "Custom";
  }
  return FREQUENCY_LABEL[rule.frequency];
}

/**
 * The next upcoming occurrence (occurrenceDate) of this rule, skipping
 * past dates. Falls back to the anchor when the rule already ended.
 */
function nextOccurrence(rule: RecurringRule, today: DateOnly): DateOnly {
  const upcoming = enumerateOccurrences(rule, [], today, addDays(today, 730));
  return upcoming[0]?.occurrenceDate ?? rule.nextDueDate;
}

/** Minor units -> plain dollar text for the amount input (integer math only). */
function minorToDollarsText(minor: MinorUnits, currency: string): string {
  const d = decimalsOf(currency);
  const unit = 10 ** d;
  const whole = Math.trunc(minor / unit);
  if (d === 0) return String(whole);
  const frac = Math.abs(minor - whole * unit)
    .toString()
    .padStart(d, "0");
  return `${whole}.${frac}`;
}

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

function StatusBadge({ status }: { status: RuleStatus }) {
  const cls =
    status === "Active"
      ? "bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900"
      : status === "Paused"
        ? "bg-stone-200 dark:bg-stone-700 text-stone-600 dark:text-stone-400"
        : "bg-stone-100 dark:bg-stone-800 text-stone-400";
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${cls}`}
    >
      {status}
    </span>
  );
}

const actionBtn =
  "rounded-full border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-3 py-1.5 text-xs font-medium text-stone-700 dark:text-stone-300 transition-colors hover:bg-stone-100 dark:hover:bg-stone-800";

interface RecurringRulesProps {
  onChanged: () => void;
  onStartPaydayRun?: (payDate: DateOnly) => void;
  /**
   * When set to a rule id, opens that rule's edit sheet once the rules
   * have loaded, then reports back via onEditRuleOpened so the caller
   * can clear it. Used by Today's Moves deep-links.
   */
  editRuleId?: string | null;
  onEditRuleOpened?: () => void;
}

export function RecurringRules({ onChanged, onStartPaydayRun, editRuleId, onEditRuleOpened }: RecurringRulesProps) {
  const [rules, setRules] = useState<RecurringRule[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [annualCosts, setAnnualCosts] = useState<Map<string, MinorUnits>>(new Map());
  const [tab, setTab] = useState<RecurringKind>("Bill");
  const [confirmEndId, setConfirmEndId] = useState<string | null>(null);

  // Sheet state (null = closed).
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<RecurringRule | null>(null);
  const [kind, setKind] = useState<RecurringKind>("Bill");
  const [name, setName] = useState("");
  const [amountText, setAmountText] = useState("");
  const [accountId, setAccountId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [frequency, setFrequency] = useState<Frequency>("monthly");
  const [intervalText, setIntervalText] = useState("30");
  const [daysOfMonth, setDaysOfMonth] = useState<number[]>([1, 15]);
  const [nextDueDate, setNextDueDate] = useState<DateOnly>(todayLocal());
  const [weekendShift, setWeekendShift] = useState<WeekendShift>("none");
  const [autoPay, setAutoPay] = useState(false);
  const [reminderText, setReminderText] = useState("3");
  const [isVariableAmount, setIsVariableAmount] = useState(false);
  const [isCreditCardPayment, setIsCreditCardPayment] = useState(false);
  const [payToAccountId, setPayToAccountId] = useState("");
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [sheetSaving, setSheetSaving] = useState(false);

  const today = todayLocal();

  const reload = async () => {
    const repos = createRepositories(getActiveDb());
    const [allRules, accts, cats] = await Promise.all([
      repos.recurringRules.getAll(),
      repos.accounts.active(),
      repos.categories.getAll(),
    ]);
    setRules(allRules);
    setAccounts(accts);
    setCategories(cats.filter((c) => !c.archived));
    // Annual cost is shown on subscription rows; overrides are needed for
    // per-occurrence amounts, so fetch them per subscription rule.
    const now = todayLocal();
    const entries = await Promise.all(
      allRules
        .filter((r) => r.kind === "Subscription")
        .map(async (r) => {
          const overrides = await repos.recurringOverrides.byRule(r.id);
          return [r.id, annualCost(r, overrides, now)] as const;
        }),
    );
    setAnnualCosts(new Map(entries));
  };

  useEffect(() => {
    void reload();
  }, []);

  const persistRule = async (rule: RecurringRule) => {
    const repos = createRepositories(getActiveDb());
    await repos.recurringRules.put(rule);
    await reload();
    onChanged();
  };

  const togglePause = (rule: RecurringRule) => {
    setConfirmEndId(null);
    void persistRule({ ...rule, active: !rule.active, updatedAt: new Date().toISOString() });
  };

  const confirmEnd = (rule: RecurringRule) => {
    if (confirmEndId !== rule.id) {
      setConfirmEndId(rule.id);
      return;
    }
    setConfirmEndId(null);
    void persistRule({
      ...rule,
      endDate: todayLocal(),
      updatedAt: new Date().toISOString(),
    });
  };

  const makePrimary = (rule: RecurringRule) => {
    const now = new Date().toISOString();
    const next = setPrimaryPayday(rules, rule.id, now);
    const changed = next.filter((r, i) => r !== rules[i]);
    if (changed.length === 0) return;
    const run = async () => {
      const repos = createRepositories(getActiveDb());
      await Promise.all(changed.map((r) => repos.recurringRules.put(r)));
      await reload();
      onChanged();
    };
    void run();
  };

  const toggleUnused = (rule: RecurringRule) => {
    void persistRule({
      ...rule,
      unusedFlag: !rule.unusedFlag,
      updatedAt: new Date().toISOString(),
    });
  };

  /* ------------------------- create/edit sheet ------------------------- */

  const visibleCategories =
    kind === "Income"
      ? categories.filter((c) => c.kind === "income")
      : expenseCategories(categories);

  const openSheet = (toEdit: RecurringRule | null, presetKind: RecurringKind) => {
    const k = toEdit ? toEdit.kind : presetKind;
    setEditing(toEdit);
    setKind(k);
    setName(toEdit?.name ?? "");
    setAmountText(toEdit ? minorToDollarsText(toEdit.amount, toEdit.currency) : "");
    setAccountId(toEdit?.accountId ?? accounts[0]?.id ?? "");
    const catsForKind =
      k === "Income"
        ? categories.filter((c) => c.kind === "income")
        : expenseCategories(categories);
    setCategoryId(toEdit?.categoryId ?? catsForKind[0]?.id ?? "");
    setFrequency(toEdit?.frequency ?? "monthly");
    setIntervalText(String(toEdit?.customIntervalDays ?? 30));
    setDaysOfMonth(toEdit?.daysOfMonth ? [...toEdit.daysOfMonth] : [1, 15]);
    setNextDueDate(toEdit?.nextDueDate ?? todayLocal());
    setWeekendShift(
      toEdit?.weekendShift ?? (k === "Income" ? "previous-business-day" : "none"),
    );
    setAutoPay(toEdit?.autoPay ?? false);
    setReminderText(String(toEdit?.reminderOffsetDays ?? 3));
    setIsVariableAmount(toEdit?.isVariableAmount ?? false);
    setIsCreditCardPayment(toEdit?.isCreditCardPayment ?? false);
    setPayToAccountId(toEdit?.payToAccountId ?? "");
    setSheetError(null);
    setSheetSaving(false);
    setConfirmEndId(null);
    setSheetOpen(true);
  };

  // Deep-link: open the requested rule's edit sheet once the rules have
  // loaded, then tell the caller the request is consumed. The ref resets
  // when the prop clears so the same rule can be deep-linked again.
  const editRequestRef = useRef<string | null>(null);
  useEffect(() => {
    if (!editRuleId) {
      editRequestRef.current = null;
      return;
    }
    if (rules.length === 0 || editRequestRef.current === editRuleId) return;
    editRequestRef.current = editRuleId;
    const rule = rules.find((r) => r.id === editRuleId);
    if (rule) {
      setTab(rule.kind);
      openSheet(rule, rule.kind);
    }
    onEditRuleOpened?.();
  }, [editRuleId, rules, onEditRuleOpened]);

  const onKindChange = (k: RecurringKind) => {
    setKind(k);
    const first =
      k === "Income"
        ? categories.find((c) => c.kind === "income")
        : expenseCategories(categories)[0];
    setCategoryId(first?.id ?? "");
    if (!editing) {
      setWeekendShift(k === "Income" ? "previous-business-day" : "none");
    }
  };

  const toggleDayOfMonth = (day: number) => {
    setDaysOfMonth((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b),
    );
  };

  const saveSheet = async () => {
    setSheetError(null);
    const trimmedName = name.trim();
    if (trimmedName === "") {
      setSheetError("Give it a name.");
      return;
    }
    const account = accounts.find((a) => a.id === accountId);
    if (!account) {
      setSheetError("Pick an account.");
      return;
    }
    const minor = parseDollarsToMinor(amountText, account.currency);
    if (minor === null) {
      setSheetError("Enter an amount like 12.34");
      return;
    }
    if (!categoryId || !visibleCategories.some((c) => c.id === categoryId)) {
      setSheetError("Pick a category.");
      return;
    }
    if (!isDateOnly(nextDueDate)) {
      setSheetError("Pick a valid due date.");
      return;
    }
    const interval = Number.parseInt(intervalText, 10);
    if (frequency === "custom" && (!Number.isInteger(interval) || interval <= 0)) {
      setSheetError("Custom interval must be a positive number of days.");
      return;
    }
    if (frequency === "semi-monthly" && daysOfMonth.length === 0) {
      setSheetError("Pick at least one day of the month.");
      return;
    }
    const reminder = Number.parseInt(reminderText, 10);
    if (!Number.isInteger(reminder) || reminder < 0) {
      setSheetError("Reminder days must be 0 or more.");
      return;
    }
    // Debt payments (card or loan) are Transfers to a card/loan account,
    // never Expenses — the "Pay to" account is required and becomes the
    // rule's debt-payment identity.
    const isDebtPaymentRule = isCreditCardPayment || payToAccountId !== "";
    const payToAccount = payToAccountId === "" ? undefined : accounts.find((a) => a.id === payToAccountId);
    if (isDebtPaymentRule && !payToAccount) {
      setSheetError("Pick the card or loan account this pays to.");
      return;
    }
    if (isDebtPaymentRule && payToAccount && account.id === payToAccount.id) {
      setSheetError("Pick a different account than the one being paid.");
      return;
    }
    setSheetSaving(true);
    try {
      const now = new Date().toISOString();
      const base: RecurringRule =
        editing ??
        ({
          id: crypto.randomUUID(),
          skippedDates: [] as DateOnly[],
          active: true,
          createdAt: now,
        } as RecurringRule);
      const rule: RecurringRule = {
        ...base,
        kind,
        name: trimmedName,
        amount: minor,
        currency: account.currency,
        accountId,
        categoryId,
        frequency,
        customIntervalDays: frequency === "custom" ? interval : undefined,
        daysOfMonth: frequency === "semi-monthly" ? [...daysOfMonth].sort((a, b) => a - b) : undefined,
        nextDueDate,
        weekendShift,
        autoPay,
        reminderOffsetDays: reminder,
        isVariableAmount,
        isCreditCardPayment,
        payToAccountId: payToAccount?.id,
        updatedAt: now,
      };
      await persistRule(rule);
      setSheetOpen(false);
    } catch (e) {
      setSheetError(e instanceof Error ? e.message : "Could not save. Try again.");
      setSheetSaving(false);
    }
  };

  /* ------------------------------ list ------------------------------ */

  const tabRules = rules
    .filter((r) => r.kind === tab)
    .sort((a, b) => {
      // Active first, then paused, then ended; within a group by name.
      const rank = (r: RecurringRule) =>
        statusOf(r, today) === "Active" ? 0 : statusOf(r, today) === "Paused" ? 1 : 2;
      return rank(a) - rank(b) || a.name.localeCompare(b.name);
    });

  const counts = (kind: RecurringKind) => rules.filter((r) => r.kind === kind).length;

  const renderRow = (rule: RecurringRule) => {
    const status = statusOf(rule, today);
    const next = nextOccurrence(rule, today);
    const cost = annualCosts.get(rule.id);
    return (
      <li key={rule.id} className="rounded-2xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">{rule.name}</p>
              {rule.kind === "Income" && rule.isPrimaryPayday && (
                <span className="rounded-full border border-stone-900 dark:border-stone-100 px-2 py-0.5 text-[11px] font-semibold text-stone-900 dark:text-stone-100">
                  Primary
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              {frequencyLabel(rule)} · Next {prettyDate(next)}
              {rule.isVariableAmount && " · varies"}
              {rule.autoPay && " · autopay"}
            </p>
            {rule.kind === "Subscription" && cost !== undefined && (
              <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                ≈ {formatMoney(cost, rule.currency)}/year
              </p>
            )}
          </div>
          <div className="shrink-0 text-right">
            <p className="font-display text-lg text-stone-900 dark:text-stone-100">
              {formatMoney(rule.amount, rule.currency)}
            </p>
            <div className="mt-1">
              <StatusBadge status={status} />
            </div>
          </div>
        </div>

        {rule.kind === "Subscription" && (
          <div className="mt-3 flex items-center justify-between rounded-xl bg-stone-50 dark:bg-stone-800 px-3 py-2">
            <span className="text-xs font-medium text-stone-600 dark:text-stone-400">Unused / Cancel?</span>
            <Toggle
              checked={rule.unusedFlag ?? false}
              onChange={() => toggleUnused(rule)}
              label={`Mark ${rule.name} as unused`}
            />
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={() => openSheet(rule, tab)} className={actionBtn}>
            Edit
          </button>
          <button type="button" onClick={() => togglePause(rule)} className={actionBtn}>
            {rule.active ? "Pause" : "Resume"}
          </button>
          {status !== "Ended" && (
            <button type="button" onClick={() => confirmEnd(rule)} className={actionBtn}>
              {confirmEndId === rule.id ? "Confirm end?" : "End"}
            </button>
          )}
          {rule.kind === "Income" && !rule.isPrimaryPayday && (
            <button type="button" onClick={() => makePrimary(rule)} className={actionBtn}>
              Set as primary payday
            </button>
          )}
          {rule.kind === "Income" && rule.isPrimaryPayday && onStartPaydayRun && (
            <button
              type="button"
              onClick={() => onStartPaydayRun(next)}
              className="rounded-full bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-xs font-medium text-white dark:text-stone-900 transition-colors hover:bg-stone-700 dark:hover:bg-stone-200"
            >
              Start payday run
            </button>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-xl text-stone-900 dark:text-stone-100">Recurring</h2>
        <button
          type="button"
          onClick={() => openSheet(null, tab)}
          className="rounded-full bg-stone-900 dark:bg-stone-100 px-4 py-2 text-sm font-medium text-white dark:text-stone-900 transition-colors hover:bg-stone-700 dark:hover:bg-stone-200"
        >
          Add
        </button>
      </div>

      <div className="flex rounded-full bg-stone-100 dark:bg-stone-800 p-1" role="tablist" aria-label="Rule type">
        {TABS.map((t) => (
          <button
            key={t.kind}
            type="button"
            role="tab"
            aria-selected={tab === t.kind}
            onClick={() => setTab(t.kind)}
            className={`flex-1 rounded-full py-2 text-sm font-medium transition-colors ${
              tab === t.kind
                ? "bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-sm"
                : "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300"
            }`}
          >
            {t.label} · {counts(t.kind)}
          </button>
        ))}
      </div>

      {tabRules.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 p-8 text-center text-sm text-stone-500 dark:text-stone-400">
          No {TABS.find((t) => t.kind === tab)?.label.toLowerCase()} yet. Tap Add to create one.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">{tabRules.map(renderRow)}</ul>
      )}

      {sheetOpen && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Close"
            onClick={() => setSheetOpen(false)}
            className="absolute inset-0 bg-black/40"
          />
          <div className="absolute bottom-0 inset-x-0 mx-auto max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white dark:bg-stone-900 p-5 pb-8">
            <div className="flex items-start justify-between">
              <h2 className="font-display text-xl text-stone-900 dark:text-stone-100">
                {editing ? "Edit rule" : "New rule"}
              </h2>
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                aria-label="Close rule editor"
                className="flex h-8 w-8 items-center justify-center rounded-full text-lg text-stone-500 dark:text-stone-400 transition-colors hover:bg-stone-100 dark:hover:bg-stone-800"
              >
                ×
              </button>
            </div>

            <div className="mt-4 flex flex-col gap-4">
              <div>
                <span className={labelCls}>Type</span>
                <div
                  className="flex rounded-full bg-stone-100 dark:bg-stone-800 p-1"
                  role="group"
                  aria-label="Rule type"
                >
                  {(Object.keys(KIND_LABEL) as RecurringKind[]).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => onKindChange(k)}
                      className={`flex-1 rounded-full py-2 text-sm font-medium transition-colors ${
                        kind === k
                          ? "bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 shadow-sm"
                          : "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300"
                      }`}
                    >
                      {KIND_LABEL[k]}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label htmlFor="rr-name" className={labelCls}>
                  Name
                </label>
                <input
                  id="rr-name"
                  type="text"
                  placeholder={kind === "Income" ? "Paycheck" : "e.g. Con Edison"}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={fieldCls}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="rr-amount" className={labelCls}>
                    Amount
                  </label>
                  <input
                    id="rr-amount"
                    type="text"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={amountText}
                    onChange={(e) => setAmountText(e.target.value)}
                    className={fieldCls}
                  />
                </div>
                <div>
                  <label htmlFor="rr-account" className={labelCls}>
                    Account
                  </label>
                  <select
                    id="rr-account"
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                    className={fieldCls}
                  >
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="rr-category" className={labelCls}>
                  Category
                </label>
                <select
                  id="rr-category"
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  className={fieldCls}
                >
                  {visibleCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="rr-frequency" className={labelCls}>
                  Frequency
                </label>
                <select
                  id="rr-frequency"
                  value={frequency}
                  onChange={(e) => setFrequency(e.target.value as Frequency)}
                  className={fieldCls}
                >
                  {FREQUENCIES.map((f) => (
                    <option key={f} value={f}>
                      {FREQUENCY_LABEL[f]}
                    </option>
                  ))}
                </select>
              </div>

              {frequency === "custom" && (
                <div>
                  <label htmlFor="rr-interval" className={labelCls}>
                    Every how many days?
                  </label>
                  <input
                    id="rr-interval"
                    type="number"
                    min={1}
                    step={1}
                    value={intervalText}
                    onChange={(e) => setIntervalText(e.target.value)}
                    className={fieldCls}
                  />
                </div>
              )}

              {frequency === "semi-monthly" && (
                <div>
                  <span className={labelCls}>Days of the month</span>
                  <div className="flex flex-wrap gap-1.5">
                    {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                      <button
                        key={day}
                        type="button"
                        onClick={() => toggleDayOfMonth(day)}
                        aria-pressed={daysOfMonth.includes(day)}
                        className={`h-8 w-8 rounded-full text-xs font-medium transition-colors ${
                          daysOfMonth.includes(day)
                            ? "bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900"
                            : "bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700"
                        }`}
                      >
                        {day}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="rr-next-due" className={labelCls}>
                    Next due
                  </label>
                  <input
                    id="rr-next-due"
                    type="date"
                    value={nextDueDate}
                    onChange={(e) =>
                      setNextDueDate(isDateOnly(e.target.value) ? e.target.value : todayLocal())
                    }
                    className={fieldCls}
                  />
                </div>
                <div>
                  <label htmlFor="rr-weekend" className={labelCls}>
                    Weekend shift
                  </label>
                  <select
                    id="rr-weekend"
                    value={weekendShift}
                    onChange={(e) => setWeekendShift(e.target.value as WeekendShift)}
                    className={fieldCls}
                  >
                    {WEEKEND_SHIFTS.map((w) => (
                      <option key={w} value={w}>
                        {WEEKEND_SHIFT_LABEL[w]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="rr-reminder" className={labelCls}>
                  Remind me (days before)
                </label>
                <input
                  id="rr-reminder"
                  type="number"
                  min={0}
                  step={1}
                  value={reminderText}
                  onChange={(e) => setReminderText(e.target.value)}
                  className={fieldCls}
                />
              </div>

              <div className="flex flex-col gap-3">
                <label className="flex items-center gap-3 text-sm text-stone-700 dark:text-stone-300">
                  <input
                    type="checkbox"
                    checked={autoPay}
                    onChange={(e) => setAutoPay(e.target.checked)}
                    className="h-4 w-4 accent-stone-900"
                  />
                  Autopay
                </label>
                <label className="flex items-center gap-3 text-sm text-stone-700 dark:text-stone-300">
                  <input
                    type="checkbox"
                    checked={isVariableAmount}
                    onChange={(e) => setIsVariableAmount(e.target.checked)}
                    className="h-4 w-4 accent-stone-900"
                  />
                  Amount varies (utilities)
                </label>
                <label className="flex items-center gap-3 text-sm text-stone-700 dark:text-stone-300">
                  <input
                    type="checkbox"
                    checked={isCreditCardPayment}
                    onChange={(e) => setIsCreditCardPayment(e.target.checked)}
                    className="h-4 w-4 accent-stone-900"
                  />
                  This pays a credit card
                </label>
              </div>

              {(isCreditCardPayment || payToAccountId !== "") && (
                <div>
                  <label htmlFor="rr-pay-to" className={labelCls}>
                    Pay to
                  </label>
                  <select
                    id="rr-pay-to"
                    value={payToAccountId}
                    onChange={(e) => setPayToAccountId(e.target.value)}
                    className={fieldCls}
                  >
                    <option value="">Choose a card or loan…</option>
                    {accounts
                      .filter((a) => a.type === "CreditCard" || a.type === "Loan")
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                  </select>
                </div>
              )}

              {sheetError && <p className="text-sm font-medium text-red-700 dark:text-red-300">{sheetError}</p>}

              <button
                type="button"
                onClick={() => void saveSheet()}
                disabled={sheetSaving}
                className="rounded-full bg-stone-900 dark:bg-stone-100 py-3 text-sm font-medium text-white dark:text-stone-900 transition-colors hover:bg-stone-700 dark:hover:bg-stone-200 disabled:opacity-60"
              >
                {sheetSaving ? "Saving…" : editing ? "Save changes" : "Add rule"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Onboarding: first-launch gate logic, v1 backup validation and
 * reconciliation, and the start-fresh writer.
 *
 * Pure where possible; the screens live in ../components/Onboarding.tsx.
 * Everything writes through repositories so the app layer stays the only
 * place that talks to Dexie. All dates are UTC DateOnly strings; all
 * money is integer minor units.
 */
import { dollarsToMinor, type MigrationResult, type V1Dashboard } from "../data/migration/fromV1.js";
import {
  dayOfMonth,
  type DateOnly,
} from "../domain/dates/dateOnly.js";
import {
  defaultCountsAsSpendable,
  toStoredBalance,
  type Account,
  type AccountType,
} from "../domain/entities/account.js";
import { DEFAULT_CATEGORIES, type Category } from "../domain/entities/category.js";
import type { Goal } from "../domain/entities/goal.js";
import type { RecurringRule } from "../domain/entities/recurringRule.js";
import type { Settings } from "../domain/entities/settings.js";
import type { MinorUnits } from "../domain/money/money.js";
import type { Repositories } from "../data/repositories/index.js";
import { createRepositories } from "../data/repositories/index.js";
import { getDb, setDemoMode } from "../data/db.js";

/**
 * First-launch gate. Shows onboarding only when the flag is unset AND the
 * database has no accounts. Existing users with data but no flag are
 * treated as onboarded; the App integration sets the flag for them
 * silently on launch.
 */
export function shouldShowOnboarding(
  settings: Settings | undefined | null,
  accountCount: number,
): boolean {
  return (settings?.onboardingCompleted ?? false) === false && accountCount === 0;
}

export type V1ShapeResult = { ok: true } | { ok: false; errors: string[] };

const V1_LIST_KEYS = ["bills", "debts", "expenses", "trip_expenses", "bill_payments"] as const;
const V1_NUMERIC_SETTINGS_KEYS = [
  "current_cash",
  "savings_goal",
  "savings_per_paycheck",
  "paycheck_amount",
  "payday_one",
  "payday_two",
] as const;

/**
 * Validate that an unknown parsed JSON value is shaped like a v1 dashboard
 * backup BEFORE migrateFromV1 ever sees it. Returns named errors so the
 * UI can say exactly what is wrong; nothing is written on failure.
 */
export function validateV1Shape(json: unknown): V1ShapeResult {
  const errors: string[] = [];
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return {
      ok: false,
      errors: ["This file is not a v1 backup. It should be a JSON object with bills, debts, expenses, and settings."],
    };
  }
  const v = json as Record<string, unknown>;

  for (const key of V1_LIST_KEYS) {
    if (!Array.isArray(v[key])) {
      errors.push(`Missing "${key}" list. This does not look like a v1 backup.`);
    }
  }

  if (typeof v.settings !== "object" || v.settings === null || Array.isArray(v.settings)) {
    errors.push('Missing "settings" section. This does not look like a v1 backup.');
  } else {
    const s = v.settings as Record<string, unknown>;
    for (const key of V1_NUMERIC_SETTINGS_KEYS) {
      const val = s[key];
      if (val !== undefined && (typeof val !== "number" || !Number.isFinite(val))) {
        errors.push(`settings.${key} must be a number, got ${describe(val)}.`);
      }
    }
  }

  if (typeof v.savings_total !== "number" || !Number.isFinite(v.savings_total)) {
    errors.push('Missing "savings_total" number. This does not look like a v1 backup.');
  }

  if (Array.isArray(v.debts)) {
    v.debts.forEach((d, i) => {
      if (typeof d !== "object" || d === null) {
        errors.push(`debts[${i}] must be an object with a name and a current balance.`);
        return;
      }
      const dd = d as Record<string, unknown>;
      if (typeof dd.name !== "string" || dd.name.trim() === "") {
        errors.push(`debts[${i}] is missing a name.`);
      }
      if (typeof dd.current_balance !== "number" || !Number.isFinite(dd.current_balance)) {
        errors.push(
          `"${typeof dd.name === "string" ? dd.name : `debts[${i}]`}" has no current balance number.`,
        );
      }
    });
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function describe(val: unknown): string {
  if (val === null) return "null";
  if (Array.isArray(val)) return "a list";
  return typeof val;
}

export interface ReconciliationRow {
  label: string;
  /** v1 amount in minor units; debts shown positive (the amount owed). */
  v1Minor: MinorUnits;
  /** Migrated v2 account balance in minor units (liabilities negative). */
  v2Minor: MinorUnits;
  /** 0 when the row reconciles. */
  diffMinor: MinorUnits;
}

const normZero = (n: number): number => (Object.is(n, -0) ? 0 : n);

/**
 * Reconcile a v1 backup against the in-memory result of migrateFromV1.
 * One row per v1 balance: cash, savings (when present), each debt.
 * Debts are stored negative in v2 while v1 carries the amount owed
 * positive, so a debt row diffs as v1Minor + v2Minor; everything else
 * diffs as v1Minor - v2Minor. Full match means every diff is 0 and the
 * import may proceed.
 */
export function reconciliationDiffs(v1: V1Dashboard, migrated: MigrationResult): ReconciliationRow[] {
  const rows: ReconciliationRow[] = [];
  const accountByName = new Map(migrated.accounts.map((a) => [a.name, a]));
  const push = (label: string, v1Minor: MinorUnits, v2Minor: MinorUnits, isDebt: boolean): void => {
    const stored = normZero(v2Minor);
    rows.push({
      label,
      v1Minor,
      v2Minor: stored,
      diffMinor: normZero(isDebt ? v1Minor + stored : v1Minor - stored),
    });
  };
  push(
    "Cash",
    dollarsToMinor(v1.settings.current_cash ?? 0),
    accountByName.get("Cash")?.startingBalance ?? 0,
    false,
  );
  if ((v1.savings_total ?? 0) > 0) {
    push(
      "Savings",
      dollarsToMinor(v1.savings_total),
      accountByName.get("Savings")?.startingBalance ?? 0,
      false,
    );
  }
  for (const d of v1.debts) {
    push(
      d.name,
      dollarsToMinor(d.current_balance ?? 0),
      accountByName.get(d.name)?.startingBalance ?? 0,
      true,
    );
  }
  return rows;
}

/**
 * Repositories bound to the REAL database for onboarding writes. Demo
 * mode is switched off first, so every onboarding write lands in the
 * real database — the Load-demo path is the only one that may use the
 * demo database. Call this first in any onboarding flow; after it runs,
 * getActiveDb() reads (e.g. loadDashboardState()) also see the real db.
 */
export function realRepositories(): Repositories {
  setDemoMode(false);
  return createRepositories(getDb());
}

/** Mark onboarding finished: sets the flag on the existing settings row,
 * or creates default settings when the row does not exist yet. */
export async function markOnboardingComplete(repos: Repositories): Promise<void> {  const existing = await repos.settings.get();
  if (existing) {
    await repos.settings.save({ ...existing, onboardingCompleted: true });
  } else {
    await repos.settings.save({
      id: "settings",
      baseCurrency: "USD",
      bufferAmount: 0,
      theme: "system",
      notificationsEnabled: false,
      onboardingCompleted: true,
    });
  }
}

export interface FreshAccountDraft {
  id: string;
  name: string;
  type: AccountType;
  /** Entered in minor units; liabilities are entered positive (amount owed). */
  enteredMinor: MinorUnits;
}

export interface FreshPaydayDraft {
  amountMinor: MinorUnits;
  /** The next payday dates the user entered; days-of-month derive from these. */
  dates: DateOnly[];
  frequency: "semi-monthly" | "monthly";
}

export interface FreshBillDraft {
  id: string;
  name: string;
  amountMinor: MinorUnits;
  nextDueDate: DateOnly;
  accountId: string;
}

export interface FreshGoalDraft {
  name: string;
  targetMinor: MinorUnits;
  targetDate?: DateOnly;
}

export interface FreshOnboardingDraft {
  accounts: FreshAccountDraft[];
  payday: FreshPaydayDraft | null;
  bills: FreshBillDraft[];
  goal: FreshGoalDraft | null;
}

/**
 * Write the start-fresh wizard result to the real database: default
 * categories, accounts (liabilities stored negative), the primary payday
 * Income rule, monthly bill rules, and the optional goal. Throws when the
 * draft has no accounts; otherwise never partially writes (callers
 * validate drafts through the wizard before calling).
 */
export async function writeFreshOnboarding(
  repos: Repositories,
  draft: FreshOnboardingDraft,
  opts: { today: DateOnly; nowIso: string },
): Promise<void> {
  const { today, nowIso } = opts;
  if (draft.accounts.length === 0) {
    throw new Error("Add at least one account before continuing.");
  }

  const categories: Category[] = DEFAULT_CATEGORIES.map((c) => ({
    id: crypto.randomUUID(),
    ...c,
    archived: false,
  }));
  await repos.categories.putMany(categories);
  const categoryIdOf = (name: string): string => {
    const found = categories.find((c) => c.name === name);
    if (!found) throw new Error(`Default category "${name}" is missing.`);
    return found.id;
  };

  const accounts: Account[] = draft.accounts.map((a) => ({
    id: a.id,
    name: a.name.trim(),
    type: a.type,
    currency: "USD",
    startingBalance: toStoredBalance(a.type, a.enteredMinor),
    startingDate: today,
    countsAsSpendable: defaultCountsAsSpendable(a.type),
    archived: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  }));
  await repos.accounts.putMany(accounts);

  const primaryAccount = accounts.find((a) => a.type === "Checking") ?? accounts[0]!;
  const rules: RecurringRule[] = [];

  if (draft.payday) {
    const days = [...new Set(draft.payday.dates.map((d) => dayOfMonth(d)))].sort((a, b) => a - b);
    const nextDueDate = [...draft.payday.dates].sort()[0]!;
    rules.push({
      id: crypto.randomUUID(),
      kind: "Income",
      name: "Paycheck",
      amount: draft.payday.amountMinor,
      currency: "USD",
      accountId: primaryAccount.id,
      categoryId: categoryIdOf("Income"),
      frequency: draft.payday.frequency,
      daysOfMonth: draft.payday.frequency === "semi-monthly" ? days : undefined,
      nextDueDate,
      weekendShift: "previous-business-day",
      autoPay: false,
      reminderOffsetDays: 3,
      isPrimaryPayday: true,
      skippedDates: [],
      active: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }

  const otherId = categoryIdOf("Other");
  for (const b of draft.bills) {
    // Guard against a draft referencing an account that no longer exists
    // (e.g. removed after the bill row was created): fall back to the
    // first account rather than writing a dangling reference.
    const accountId = accounts.some((a) => a.id === b.accountId) ? b.accountId : accounts[0]!.id;
    rules.push({
      id: crypto.randomUUID(),
      kind: "Bill",
      name: b.name.trim(),
      amount: b.amountMinor,
      currency: "USD",
      accountId,
      categoryId: otherId,
      frequency: "monthly",
      nextDueDate: b.nextDueDate,
      weekendShift: "none",
      autoPay: false,
      reminderOffsetDays: 3,
      skippedDates: [],
      active: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }
  if (rules.length > 0) {
    await repos.recurringRules.putMany(rules);
  }

  if (draft.goal) {
    const goal: Goal = {
      id: crypto.randomUUID(),
      name: draft.goal.name.trim(),
      targetAmount: draft.goal.targetMinor,
      currency: "USD",
      targetDate: draft.goal.targetDate,
      pinnedContribution: null,
      priority: 1,
      paused: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await repos.goals.put(goal);
  }
}

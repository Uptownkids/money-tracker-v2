/**
 * Needs-review inbox actions (Phase B). Every action resolves the review
 * item; the underlying transaction already counts toward balances, so
 * review only fixes up how it's described.
 */
import type { Repositories } from "../data/repositories/index.js";
import type { Transaction } from "../domain/entities/transaction.js";
import type { MerchantRule } from "../domain/entities/merchantRule.js";
import type { Frequency, RecurringRule } from "../domain/entities/recurringRule.js";
import type { MinorUnits } from "../domain/money/money.js";
import { addDays, addMonthsClamped } from "../domain/dates/dateOnly.js";
import { EXTERNAL_ACCOUNT_ID } from "../domain/import/selfTransfers.js";
import {
  applyRecurringPriceChange,
  createRuleForMerchant,
  findClosestRule,
  reactivateRecurringRule,
} from "./recurringDetect.js";

function repos_now(): string {
  return new Date().toISOString();
}

/** Remember a confirmed transfer pair, creating settings if missing. */
async function rememberTransferPair(
  repos: Repositories,
  fromAccountId: string,
  toAccountId: string,
): Promise<void> {
  const existing = await repos.settings.get();
  const pairKey = `${fromAccountId}>${toAccountId}`;
  if (existing) {
    const pairs = new Set(existing.confirmedTransferPairs ?? []);
    if (!pairs.has(pairKey)) {
      pairs.add(pairKey);
      await repos.settings.save({ ...existing, confirmedTransferPairs: [...pairs] });
    }
    return;
  }
  await repos.settings.save({
    id: "settings",
    baseCurrency: "USD",
    bufferAmount: 0,
    theme: "system",
    notificationsEnabled: false,
    onboardingCompleted: true,
    confirmedTransferPairs: [pairKey],
  });
}

async function getItem(repos: Repositories, itemId: string) {
  const item = await repos.reviewItems.getById(itemId);
  if (!item) throw new Error(`review action: unknown item "${itemId}"`);
  if (item.status !== "open") throw new Error("review action: item is not open");
  const tx = await repos.transactions.getById(item.transactionId);
  if (!tx) throw new Error("review action: transaction is gone");
  return { item, tx };
}

async function resolveItem(repos: Repositories, itemId: string): Promise<void> {
  const item = await repos.reviewItems.getById(itemId);
  if (!item) return;
  await repos.reviewItems.put({ ...item, status: "resolved", resolvedAt: repos_now() });
}

/**
 * Save (or update) a learned merchant rule, then apply it to every OTHER
 * open review item with the same merchant key — one confirmation fixes
 * the whole merchant.
 */
export async function saveMerchantRule(
  repos: Repositories,
  merchantKey: string,
  categoryId: string,
  payeeName: string,
): Promise<number> {
  const now = repos_now();
  const existing = (await repos.merchantRules.getAll()).find((r) => r.merchantKey === merchantKey);
  if (existing) {
    await repos.merchantRules.put({ ...existing, categoryId, payeeName, updatedAt: now });
  } else {
    const rule: MerchantRule = {
      id: crypto.randomUUID(),
      merchantKey,
      categoryId,
      payeeName,
      createdAt: now,
      updatedAt: now,
    };
    await repos.merchantRules.put(rule);
  }
  // Apply to other open items for the same merchant.
  const open = await repos.reviewItems.open();
  let applied = 0;
  for (const item of open) {
    if (item.merchantKey !== merchantKey) continue;
    const tx = await repos.transactions.getById(item.transactionId);
    if (!tx) continue;
    await repos.transactions.put({ ...tx, categoryId, payee: payeeName, updatedAt: now });
    await resolveItem(repos, item.id);
    applied++;
  }
  return applied;
}

/** Confirm the engine's best guess (optionally saving it as a rule). */
export async function confirmReviewItem(
  repos: Repositories,
  itemId: string,
  always: boolean,
): Promise<void> {
  const { item, tx } = await getItem(repos, itemId);
  const now = repos_now();
  const updated: Transaction = { ...tx, updatedAt: now };
  if (item.guess.payee !== undefined) updated.payee = item.guess.payee;
  if (item.guess.categoryId !== undefined) updated.categoryId = item.guess.categoryId;
  if (item.guess.type === "Transfer") {
    if (!item.guess.transferToAccountId) {
      throw new Error("confirmReviewItem: transfer guess has no destination account");
    }
    updated.type = "Transfer";
    updated.transferToAccountId = item.guess.transferToAccountId;
    updated.categoryId = null;
  } else if (item.guess.type !== undefined) {
    updated.type = item.guess.type;
  }
  await repos.transactions.put(updated);
  if (always && updated.categoryId) {
    await saveMerchantRule(repos, item.merchantKey, updated.categoryId, updated.payee);
  }
  await resolveItem(repos, itemId);
}

/** Change the category (and optionally the payee), resolving the item. */
export async function recategorizeReviewItem(
  repos: Repositories,
  itemId: string,
  categoryId: string,
  payee: string | undefined,
  always: boolean,
): Promise<void> {
  const { item, tx } = await getItem(repos, itemId);
  const category = await repos.categories.getById(categoryId);
  if (!category) throw new Error(`recategorizeReviewItem: unknown category "${categoryId}"`);
  const now = repos_now();
  await repos.transactions.put({
    ...tx,
    categoryId,
    payee: payee ?? tx.payee,
    updatedAt: now,
  });
  if (always) {
    await saveMerchantRule(repos, item.merchantKey, categoryId, payee ?? tx.payee);
  }
  await resolveItem(repos, itemId);
}

/** Convert the row into a Transfer to the chosen account (or "external"). */
export async function markTransferReviewItem(
  repos: Repositories,
  itemId: string,
  toAccountId: string,
): Promise<void> {
  const { item, tx } = await getItem(repos, itemId);
  if (tx.accountId === toAccountId) {
    throw new Error("markTransferReviewItem: pick a different destination account");
  }
  if (toAccountId !== EXTERNAL_ACCOUNT_ID) {
    const dest = await repos.accounts.getById(toAccountId);
    if (!dest) throw new Error(`markTransferReviewItem: unknown account "${toAccountId}"`);
  }
  const now = repos_now();
  await repos.transactions.put({
    ...tx,
    type: "Transfer",
    transferToAccountId: toAccountId,
    categoryId: null,
    updatedAt: now,
  });
  // A human-confirmed transfer pair is trusted from now on
  // (external destinations aren't pairs to remember).
  if (toAccountId !== EXTERNAL_ACCOUNT_ID) {
    await rememberTransferPair(repos, tx.accountId, toAccountId);
  }
  await resolveItem(repos, itemId);
}

/** Link the row to a bill/subscription rule ("this is my X bill"). */
export async function linkBillReviewItem(
  repos: Repositories,
  itemId: string,
  ruleId: string,
): Promise<void> {
  const { item, tx } = await getItem(repos, itemId);
  const rule = await repos.recurringRules.getById(ruleId);
  if (!rule) throw new Error(`linkBillReviewItem: unknown rule "${ruleId}"`);
  const now = repos_now();
  await repos.transactions.put({
    ...tx,
    recurringRuleId: ruleId,
    categoryId: rule.categoryId,
    updatedAt: now,
  });
  await resolveItem(repos, itemId);
}

export interface NewBillInput {
  name: string;
  /** Positive minor units. */
  amountMinor: number;
  kind: "Bill" | "Subscription";
  frequency: Frequency;
  categoryId: string;
}

/**
 * Create a bill/subscription rule from a review item and link the
 * transaction to it. The rule books on the transaction's own account —
 * this is the fix for bills that aren't credit-card payments (e.g. an
 * Apple subscription paid straight from checking).
 */
export async function createBillFromReviewItem(
  repos: Repositories,
  itemId: string,
  input: NewBillInput,
): Promise<string> {
  const { tx } = await getItem(repos, itemId);
  const name = input.name.trim();
  if (!name) throw new Error("createBillFromReviewItem: name is required");
  if (!Number.isFinite(input.amountMinor) || input.amountMinor <= 0) {
    throw new Error("createBillFromReviewItem: amount must be positive");
  }
  const category = await repos.categories.getById(input.categoryId);
  if (!category) throw new Error(`createBillFromReviewItem: unknown category "${input.categoryId}"`);

  const now = repos_now();
  const nextDueDate =
    input.frequency === "weekly"
      ? addDays(tx.date, 7)
      : input.frequency === "biweekly"
        ? addDays(tx.date, 14)
        : input.frequency === "annual"
          ? addMonthsClamped(tx.date, 12)
          : addMonthsClamped(tx.date, 1);
  const rule: RecurringRule = {
    id: crypto.randomUUID(),
    kind: input.kind,
    name,
    amount: Math.round(input.amountMinor) as MinorUnits,
    currency: "USD",
    accountId: tx.accountId,
    categoryId: input.categoryId,
    frequency: input.frequency,
    nextDueDate,
    weekendShift: "none",
    autoPay: false,
    reminderOffsetDays: 3,
    skippedDates: [],
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  await repos.recurringRules.put(rule);
  await repos.transactions.put({
    ...tx,
    recurringRuleId: rule.id,
    categoryId: input.categoryId,
    updatedAt: now,
  });
  await resolveItem(repos, itemId);
  return rule.id;
}

/** Hide the item from review. The transaction still counts in balances. */
export async function ignoreReviewItem(repos: Repositories, itemId: string): Promise<void> {
  const item = await repos.reviewItems.getById(itemId);
  if (!item) throw new Error(`ignoreReviewItem: unknown item "${itemId}"`);
  if (item.status !== "open") throw new Error("ignoreReviewItem: item is not open");
  await repos.reviewItems.put({ ...item, status: "ignored", resolvedAt: repos_now() });
  // Ignoring a recurring suggestion means "don't ask again for this merchant".
  if (item.reasons.includes("weak-recurring")) {
    const s = await repos.settings.get();
    if (s) {
      const dismissed = new Set(s.recurringDismissed ?? []);
      dismissed.add(item.merchantKey);
      await repos.settings.save({ ...s, recurringDismissed: [...dismissed] });
    }
  }
}

/**
 * Confirm a detected self-transfer. With `always`, the account pair is
 * remembered so future transfers for the pair skip review.
 */
export async function confirmTransferPair(
  repos: Repositories,
  itemId: string,
  always: boolean,
): Promise<void> {
  const { item, tx } = await getItem(repos, itemId);
  if (tx.type !== "Transfer" || !tx.transferToAccountId) {
    throw new Error("confirmTransferPair: item is not a transfer");
  }
  if (always) {
    await rememberTransferPair(repos, tx.accountId, tx.transferToAccountId);
  }
  await resolveItem(repos, itemId);
}

// --- Phase B2: recurring review actions ---

/**
 * Confirm a weak-recurring suggestion: create the rule now (tags past
 * charges) and resolve the suggestion.
 */
export async function confirmRecurringSuggestion(
  repos: Repositories,
  itemId: string,
): Promise<string | null> {
  const { item, tx } = await getItem(repos, itemId);
  const info = await createRuleForMerchant(repos, item.merchantKey, tx.amount);
  await resolveItem(repos, itemId);
  return info ? info.message : null;
}

/** Accept a price increase: update the rule to the new amount. */
export async function applyPriceIncrease(repos: Repositories, itemId: string): Promise<void> {
  const { item, tx } = await getItem(repos, itemId);
  const rule = findClosestRule(
    (await repos.recurringRules.getAll()).filter((r) => r.autoCreated),
    item.merchantKey,
    tx.amount,
  );
  if (!rule) throw new Error("applyPriceIncrease: no auto-created rule for this merchant");
  await applyRecurringPriceChange(repos, rule.id, tx.amount);
  await resolveItem(repos, itemId);
}

/**
 * Resolve a missed-charge flag. `reactivate=true` means "it's still
 * active" — the rule is turned back on.
 */
export async function resolveMissedCharge(
  repos: Repositories,
  itemId: string,
  reactivate: boolean,
): Promise<void> {
  const { item, tx } = await getItem(repos, itemId);
  if (reactivate) {
    const rule = findClosestRule(
      (await repos.recurringRules.getAll()).filter((r) => r.autoCreated),
      item.merchantKey,
      tx.amount,
    );
    if (rule) await reactivateRecurringRule(repos, rule.id);
  }
  await resolveItem(repos, itemId);
}

/**
 * Resolve a resurrected-merchant flag. `reactivate=true` turns the ended
 * rule back on and tags the new charge with it.
 */
export async function resolveResurrected(
  repos: Repositories,
  itemId: string,
  reactivate: boolean,
): Promise<void> {
  const { item, tx } = await getItem(repos, itemId);
  if (reactivate) {
    const rule = findClosestRule(
      (await repos.recurringRules.getAll()).filter((r) => r.autoCreated),
      item.merchantKey,
      tx.amount,
    );
    if (!rule) throw new Error("resolveResurrected: no auto-created rule for this merchant");
    await reactivateRecurringRule(repos, rule.id);
    await repos.transactions.put({ ...tx, recurringRuleId: rule.id, updatedAt: repos_now() });
  }
  await resolveItem(repos, itemId);
}

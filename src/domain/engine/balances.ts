/**
 * Derived account balances. Balance is never stored: it is the account's
 * starting balance (the balance ON startingDate) plus the sum of Cleared
 * and Pending transactions dated on or after startingDate.
 *
 * Transactions dated before an account's startingDate are history only:
 * they stay in the ledger and Insights but never move a balance (their
 * effect is already inside the starting balance — counting them again
 * would double-count). Scheduled rows never affect balances.
 * Self-transfers (accountId == transferToAccountId) are balance-neutral
 * by definition. Each side of a transfer is checked against its own
 * account's startingDate.
 */
import type { MinorUnits } from "../money/money.js";
import { addMinor } from "../money/money.js";
import type { Account } from "../entities/account.js";
import type { Transaction } from "../entities/transaction.js";
import { affectsBalance, isSelfTransfer } from "../entities/transaction.js";

/**
 * True when the transaction is dated before the account started being
 * tracked: it belongs to history, not to the balance.
 */
export function isBeforeTrackingStarted(
  account: Account | undefined,
  date: Transaction["date"],
): boolean {
  return !!account && date < account.startingDate;
}

/**
 * Effective signed delta of one transaction on its primary account,
 * in the ACCOUNT's currency. Uses fx.baseAmount when a frozen FX
 * conversion is present (it is denominated in the account's currency);
 * per-account balances never mix currencies — cross-account sums convert
 * each balance via convertToBase(balance, account.currency).
 */
export function primaryDelta(t: Transaction): MinorUnits {
  const amt = t.fx ? t.fx.baseAmount : t.amount;
  switch (t.type) {
    case "Income":
      return amt;
    case "Expense":
      return -amt;
    case "Refund":
      return amt; // money back in; reduces category spending, not income
    case "Transfer":
      return isSelfTransfer(t) ? 0 : -amt;
  }
}

/**
 * Signed delta of a transfer on its DESTINATION account.
 * Self-transfers are net zero (primary delta is already 0).
 */
export function destinationDelta(t: Transaction): MinorUnits {
  if (t.type !== "Transfer" || !t.transferToAccountId) return 0;
  if (isSelfTransfer(t)) return 0;
  const amt = t.fx ? t.fx.baseAmount : t.amount;
  return amt;
}

export function deriveBalances(
  accounts: readonly Account[],
  transactions: readonly Transaction[],
): Record<string, MinorUnits> {
  const balances: Record<string, MinorUnits> = {};
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const a of accounts) balances[a.id] = a.startingBalance;
  for (const t of transactions) {
    if (!affectsBalance(t)) continue; // Scheduled excluded
    const account = byId.get(t.accountId);
    if (!account) continue; // unknown account: ignore
    if (isBeforeTrackingStarted(account, t.date)) continue; // history only
    balances[t.accountId] = addMinor(balances[t.accountId] as MinorUnits, primaryDelta(t));
    if (t.type === "Transfer" && t.transferToAccountId) {
      const dest = byId.get(t.transferToAccountId);
      if (!dest) continue;
      if (isBeforeTrackingStarted(dest, t.date)) continue; // destination not tracked yet
      balances[t.transferToAccountId] = addMinor(
        balances[t.transferToAccountId] as MinorUnits,
        destinationDelta(t),
      );
    }
  }
  return balances;
}

/**
 * Net worth: sum of all balances. Credit-card balances are stored
 * negative (amount owed), so a plain sum already nets assets against
 * card debt.
 */
export function netWorth(balances: Record<string, MinorUnits>): MinorUnits {
  return Object.values(balances).reduce<MinorUnits>((acc, v) => addMinor(acc, v), 0);
}

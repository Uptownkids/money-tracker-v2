/**
 * Derived account balances. Balance is never stored: it is the account's
 * starting balance plus the sum of Cleared and Pending transactions.
 * Scheduled rows never affect balances. Self-transfers
 * (accountId == transferToAccountId) are balance-neutral by definition.
 */
import type { MinorUnits } from "../money/money.js";
import { addMinor } from "../money/money.js";
import type { Account } from "../entities/account.js";
import type { Transaction } from "../entities/transaction.js";
import { affectsBalance, isSelfTransfer } from "../entities/transaction.js";

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
  for (const a of accounts) balances[a.id] = a.startingBalance;
  for (const t of transactions) {
    if (!affectsBalance(t)) continue; // Scheduled excluded
    if (balances[t.accountId] === undefined) continue; // unknown account: ignore
    balances[t.accountId] = addMinor(balances[t.accountId] as MinorUnits, primaryDelta(t));
    if (t.type === "Transfer" && t.transferToAccountId && balances[t.transferToAccountId] !== undefined) {
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

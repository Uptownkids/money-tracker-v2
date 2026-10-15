/**
 * Account balances, derived by the engine (Cleared + Pending only;
 * Scheduled never counts). Credit cards show as amounts owed.
 */
import type { Account } from "../domain/entities/account.js";
import { isLiabilityAccount } from "../domain/entities/account.js";
import { formatMoney } from "../app/format.js";

interface Props {
  accounts: Account[];
  balances: Record<string, number>;
  onSelectAccount: (accountId: string) => void;
}

const TYPE_LABEL: Record<Account["type"], string> = {
  Checking: "Checking",
  Savings: "Savings",
  Cash: "Cash",
  CreditCard: "Credit card",
  Loan: "Loan",
  Other: "Account",
};

export function BalancesList({ accounts, balances, onSelectAccount }: Props) {
  const spendable = accounts.filter((a) => a.countsAsSpendable);
  const savings = accounts.filter((a) => !a.countsAsSpendable && !isLiabilityAccount(a));
  const owed = accounts.filter((a) => isLiabilityAccount(a));

  const Row = ({ account }: { account: Account }) => {
    const balance = balances[account.id] ?? 0;
    const isOwed = isLiabilityAccount(account);
    return (
      <button
        type="button"
        onClick={() => onSelectAccount(account.id)}
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
          {isOwed && balance < 0 ? `−${formatMoney(-balance, account.currency)}` : formatMoney(balance, account.currency)}
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

  return (
    <section className="rounded-3xl border border-stone-200/70 dark:border-stone-700 bg-white dark:bg-stone-900 px-2 py-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <p className="px-4 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400">
        Balances
      </p>
      <Group title="Spendable" items={spendable} />
      <Group title="Savings" items={savings} />
      <Group title="Owed" items={owed} />
    </section>
  );
}

/**
 * Balance-correction dialog for ?adjust= deep links and inbox "adjust"
 * entries (one implementation serves both). Shows the app's derived
 * balance next to the stated balance and — only on explicit confirm —
 * records the difference as a transaction. The balance itself is never
 * silently overwritten: both numbers are always on screen.
 *
 * Decision (see decideAdjust):
 * - match: nothing to do.
 * - unlogged-spending: one Expense, Uncategorized, "Unlogged spending".
 * - money-appeared (asset accounts): the user picks Refund, IOU
 *   repayment, Forgotten income, or Just correct the balance.
 * - correction (card/loan paydown): tagged correction inflow, never income.
 * - invalid: the stated text is rejected with a plain message.
 */
import { useEffect, useState } from "react";
import { createRepositories, type Repositories } from "../data/repositories/index.js";
import { getDb } from "../data/db.js";
import { formatMoney } from "../app/format.js";
import { todayLocal } from "../domain/dates/dateOnly.js";
import type { Account } from "../domain/entities/account.js";
import type { MinorUnits } from "../domain/money/money.js";
import { deriveBalances } from "../domain/engine/balances.js";
import { decideAdjust, type AdjustDecision, type AdjustIntent } from "../utils/deepLink.js";
import {
  applyCardCorrection,
  applyMoneyAppeared,
  applyUnloggedSpending,
  type MoneyAppearedChoice,
} from "../app/adjustApply.js";

type Loaded =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      account: Account;
      appBalance: MinorUnits;
      decision: AdjustDecision;
    };

type AppearedForm = null | "iou" | "income";

const inputCls =
  "w-full rounded-xl border border-stone-200 bg-white px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:focus:border-stone-500";

export function DeepLinkAdjust({
  intent,
  accountId,
  onClose,
  onApplied,
}: {
  intent: AdjustIntent;
  accountId: string;
  onClose: () => void;
  onApplied: (message: string) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [appearedForm, setAppearedForm] = useState<AppearedForm>(null);
  const [personText, setPersonText] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const repos = createRepositories(getDb());
        const [accounts, transactions] = await Promise.all([
          repos.accounts.getAll(),
          repos.transactions.getAll(),
        ]);
        if (cancelled) return;
        const account = accounts.find((a) => a.id === accountId) ?? null;
        if (!account) {
          setLoaded({ status: "error", message: "That account is gone — nothing was recorded." });
          return;
        }
        const balances = deriveBalances(accounts, transactions);
        const appBalance = balances[account.id] ?? account.startingBalance;
        const decision = decideAdjust({
          accountType: account.type,
          appBalanceMinor: appBalance,
          statedText: intent.balanceText,
          currency: account.currency,
        });
        setLoaded({ status: "ready", account, appBalance, decision });
      } catch (e) {
        if (!cancelled) {
          setLoaded({
            status: "error",
            message: e instanceof Error ? e.message : "Couldn't load the account.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, intent]);

  const runApply = async (
    apply: (repos: Repositories) => Promise<{ id: string }>,
    successMessage: string,
  ) => {
    setSaving(true);
    setSaveError(null);
    try {
      const repos = createRepositories(getDb());
      await apply(repos);
      onApplied(successMessage);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Couldn't record it. Try again.");
      setSaving(false);
    }
  };

  const targetFor = (account: Account) => ({
    accountId: account.id,
    currency: account.currency,
    date: todayLocal(),
    nowIso: new Date().toISOString(),
  });

  const body = (() => {
    if (loaded.status === "loading") {
      return (
        <div className="flex items-center justify-center py-8">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-stone-300 border-t-stone-800 dark:border-stone-600 dark:border-t-stone-200" />
        </div>
      );
    }
    if (loaded.status === "error") {
      return <p className="py-2 text-sm text-stone-600 dark:text-stone-400">{loaded.message}</p>;
    }
    const { account, appBalance, decision } = loaded;
    const fmt = (m: MinorUnits) => formatMoney(m, account.currency);
    const isLiability = account.type === "CreditCard" || account.type === "Loan";

    if (decision.kind === "invalid") {
      return <p className="py-2 text-sm text-stone-600 dark:text-stone-400">{decision.error} — nothing was recorded.</p>;
    }
    if (decision.kind === "match") {
      return (
        <p className="py-2 text-sm text-stone-600 dark:text-stone-400">
          {account.name} already matches — nothing to record.
        </p>
      );
    }

    if (decision.kind === "unlogged-spending") {
      const diff = decision.differenceMinor;
      const prompt = isLiability ? (
        <p className="py-2 text-sm text-stone-600 dark:text-stone-400">
          {account.name} shows {fmt((-appBalance) as MinorUnits)} owed in the app, you say{" "}
          {fmt((-appBalance + diff) as MinorUnits)}. Record the {fmt(diff)} increase as
          Unlogged spending?
        </p>
      ) : (
        <p className="py-2 text-sm text-stone-600 dark:text-stone-400">
          {account.name} is {fmt(appBalance)} in the app, you say{" "}
          {fmt((appBalance - diff) as MinorUnits)}. Record the {fmt(diff)} difference as
          Unlogged spending?
        </p>
      );
      return (
        <>
          {prompt}
          {saveError && (
            <p className="text-sm font-medium text-red-700 dark:text-red-300">{saveError}</p>
          )}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() =>
                void runApply(
                  (repos) => applyUnloggedSpending(repos, targetFor(account), diff),
                  `Recorded ${fmt(diff)} unlogged spending.`,
                )
              }
              disabled={saving}
              className="flex-1 rounded-full bg-stone-900 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-700 disabled:opacity-60 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200"
            >
              {saving ? "Recording…" : "Record it"}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="flex-1 rounded-full border border-stone-300 bg-white py-2.5 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-60 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-300 dark:hover:bg-stone-800"
            >
              Cancel
            </button>
          </div>
        </>
      );
    }

    if (decision.kind === "correction") {
      const diff = decision.differenceMinor;
      return (
        <>
          <p className="py-2 text-sm text-stone-600 dark:text-stone-400">
            {account.name} shows {fmt((-appBalance) as MinorUnits)} owed in the app, you say{" "}
            {fmt((-appBalance - diff) as MinorUnits)}. Record the {fmt(diff)} paydown as a
            balance correction?
          </p>
          {saveError && (
            <p className="text-sm font-medium text-red-700 dark:text-red-300">{saveError}</p>
          )}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() =>
                void runApply(
                  (repos) => applyCardCorrection(repos, targetFor(account), diff),
                  `Recorded ${fmt(diff)} balance correction.`,
                )
              }
              disabled={saving}
              className="flex-1 rounded-full bg-stone-900 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-700 disabled:opacity-60 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200"
            >
              {saving ? "Recording…" : "Record it"}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="flex-1 rounded-full border border-stone-300 bg-white py-2.5 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-60 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-300 dark:hover:bg-stone-800"
            >
              Cancel
            </button>
          </div>
        </>
      );
    }

    // money-appeared (asset accounts): four honest options.
    const diff = decision.differenceMinor;
    const confirmAppeared = (choice: MoneyAppearedChoice, person?: string) =>
      runApply(
        (repos) => applyMoneyAppeared(repos, targetFor(account), diff, choice, person),
        choice === "refund"
          ? `Recorded ${fmt(diff)} as a refund.`
          : choice === "iou-repayment"
            ? `Recorded ${fmt(diff)} repaid by ${(person ?? "").trim()}.`
            : choice === "forgotten-income"
              ? `Recorded ${fmt(diff)} income.`
              : `Balance corrected by ${fmt(diff)}.`,
      );

    const optionBtn = (
      label: string,
      sub: string,
      onClick: () => void,
    ) => (
      <button
        type="button"
        onClick={onClick}
        disabled={saving}
        className="w-full rounded-2xl bg-stone-50 px-4 py-3 text-left transition-colors hover:bg-stone-100 disabled:opacity-60 dark:bg-stone-800/60 dark:hover:bg-stone-800"
      >
        <p className="text-sm font-medium text-stone-900 dark:text-stone-100">{label}</p>
        <p className="text-xs text-stone-500 dark:text-stone-400">{sub}</p>
      </button>
    );

    return (
      <>
        <p className="py-1 text-base font-medium text-stone-900 dark:text-stone-100">
          You have {fmt(diff)} more than the app shows.
        </p>
        <p className="pb-1 text-sm text-stone-600 dark:text-stone-400">What was it?</p>
        {saveError && (
          <p className="text-sm font-medium text-red-700 dark:text-red-300">{saveError}</p>
        )}
        <div className="flex flex-col gap-2">
          {optionBtn("Refund", "Money back in — never counts as income.", () =>
            void confirmAppeared("refund"),
          )}
          {appearedForm === "iou" ? (
            <div className="rounded-2xl bg-stone-50 p-3 dark:bg-stone-800/60">
              <label
                className="mb-1.5 block text-xs font-medium text-stone-500 dark:text-stone-400"
                htmlFor="adjust-iou-person"
              >
                Who repaid you?
              </label>
              <input
                id="adjust-iou-person"
                value={personText}
                onChange={(e) => setPersonText(e.target.value)}
                placeholder="Name"
                className={inputCls}
              />
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={saving || personText.trim() === ""}
                  onClick={() => void confirmAppeared("iou-repayment", personText)}
                  className="flex-1 rounded-full bg-stone-900 py-2 text-sm font-medium text-white transition-colors hover:bg-stone-700 disabled:opacity-60 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200"
                >
                  {saving ? "Recording…" : "Record repayment"}
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    setAppearedForm(null);
                    setPersonText("");
                  }}
                  className="rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-60 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-300 dark:hover:bg-stone-800"
                >
                  Back
                </button>
              </div>
            </div>
          ) : (
            optionBtn("IOU repayment", "Someone paid you back.", () => {
              setAppearedForm("iou");
              setPersonText("");
            })
          )}
          {appearedForm === "income" ? (
            <div className="rounded-2xl bg-stone-50 p-3 dark:bg-stone-800/60">
              <label
                className="mb-1.5 block text-xs font-medium text-stone-500 dark:text-stone-400"
                htmlFor="adjust-income-person"
              >
                From who?
              </label>
              <input
                id="adjust-income-person"
                value={personText}
                onChange={(e) => setPersonText(e.target.value)}
                placeholder="Forgotten income"
                className={inputCls}
              />
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void confirmAppeared("forgotten-income", personText)}
                  className="flex-1 rounded-full bg-stone-900 py-2 text-sm font-medium text-white transition-colors hover:bg-stone-700 disabled:opacity-60 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200"
                >
                  {saving ? "Recording…" : "Record income"}
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    setAppearedForm(null);
                    setPersonText("");
                  }}
                  className="rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-60 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-300 dark:hover:bg-stone-800"
                >
                  Back
                </button>
              </div>
            </div>
          ) : (
            optionBtn("Forgotten income", "Counts as income.", () => {
              setAppearedForm("income");
              setPersonText("");
            })
          )}
          {optionBtn(
            "Just correct the balance",
            "Records it without counting it as income.",
            () => void confirmAppeared("just-correct"),
          )}
        </div>
      </>
    );
  })();

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Balance correction">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div className="absolute inset-x-0 bottom-0 mx-auto w-full max-w-md rounded-t-3xl bg-white p-5 pb-8 dark:bg-stone-900">
        <div className="flex items-start justify-between">
          <h2 className="font-display text-xl text-stone-900 dark:text-stone-100">
            Correct balance
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close balance correction"
            className="flex h-8 w-8 items-center justify-center rounded-full text-lg text-stone-500 transition-colors hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800"
          >
            ×
          </button>
        </div>
        <div className="mt-3 flex flex-col gap-3">{body}</div>
        {loaded.status !== "ready" && loaded.status !== "loading" && (
          <button
            type="button"
            onClick={onClose}
            className="mt-4 w-full rounded-full border border-stone-300 bg-white py-2.5 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-300 dark:hover:bg-stone-800"
          >
            Close
          </button>
        )}
      </div>
    </div>
  );
}

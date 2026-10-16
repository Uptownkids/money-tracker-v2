/**
 * Categorization for imported bank rows (Phase B).
 *
 * Order of sources:
 *  1. Learned merchant rules (his corrections + "always do this").
 *  2. His history (same merchant -> same category and payee name).
 *  3. Small built-in merchant patterns (low confidence -> review).
 * Refunds reduce the original category (never income); card interest and
 * fees are expenses, never transfers.
 */
import type { Category } from "../entities/category.js";
import type { MerchantRule } from "../entities/merchantRule.js";
import { cleanPayee, looksLikeFeeOrInterest, looksLikeRefund, merchantKey } from "./payeeClean.js";

export type CategorizeConfidence = "high" | "low";
export type CategorizeVia = "learned" | "history" | "builtin" | "refund" | "fee" | "default";

export interface CategorizeResult {
  /** Null when the app cannot decide — the row needs review. */
  categoryId: string | null;
  /** Display payee (cleaned, or his corrected name). */
  payee: string;
  confidence: CategorizeConfidence;
  via: CategorizeVia;
  /** True when this row is a refund/return (reduces category spending). */
  isRefund: boolean;
}

/** One merchant's track record in the existing ledger. */
export interface MerchantHistory {
  categoryId: string;
  payee: string;
  count: number;
}

export interface CategorizeInput {
  rawDescription: string;
  isOutflow: boolean;
  categories: readonly Category[];
  learnedRules: readonly MerchantRule[];
  /** merchantKey -> history, built from existing transactions. */
  history: ReadonlyMap<string, MerchantHistory>;
}

/** Conservative built-in patterns: common merchants, safe categories. */
const BUILTIN_RULES: ReadonlyArray<{ pattern: RegExp; category: string }> = [
  { pattern: /CITI\s?BIKE/, category: "Transit" },
  { pattern: /SPOTIFY/, category: "Entertainment" },
  { pattern: /NETFLIX/, category: "Entertainment" },
  { pattern: /\bUBER\b/, category: "Transit" },
  { pattern: /\bLYFT\b/, category: "Transit" },
  { pattern: /WHOLE FOODS/, category: "Food" },
  { pattern: /TRADER JOE/, category: "Food" },
  { pattern: /AMAZON|AMZN/, category: "Shopping" },
  { pattern: /CON\s?EDISON/, category: "Utilities" },
  { pattern: /SPECTRUM/, category: "Utilities" },
  { pattern: /VERIZON/, category: "Utilities" },
  { pattern: /DUANE READE|\bCVS\b|WALGREENS/, category: "Health" },
  { pattern: /STARBUCKS|DUNKIN/, category: "Coffee" },
];

function categoryIdByName(categories: readonly Category[], name: string): string | null {
  const found =
    categories.find((c) => c.name.toLowerCase() === name.toLowerCase() && !c.archived) ??
    categories.find((c) => c.name.toLowerCase() === "other" && !c.archived);
  return found ? found.id : null;
}

export function categorize(input: CategorizeInput): CategorizeResult {
  const cleaned = cleanPayee(input.rawDescription);
  const key = merchantKey(cleaned);
  const fallbackCategory = categoryIdByName(input.categories, "Other");

  // 0. Refunds and fees are typed by pattern, before anything else.
  // For refunds, the merchant key drops the refund words and any date
  // fragments so "AMAZON REFUND 10/14" still finds Amazon's history.
  const refundMerchantKey = looksLikeRefund(input.rawDescription)
    ? merchantKey(cleanPayee(input.rawDescription.replace(/\b(REFUND|REFUNDED|RETURN|REVERSAL|CREDIT ADJUSTMENT)\b/gi, ""))).replace(
        /(\s+\d+)+$/,
        "",
      )
    : key;
  if (looksLikeRefund(input.rawDescription)) {
    const learned = input.learnedRules.find((r) => r.merchantKey === refundMerchantKey);
    const hist = input.history.get(refundMerchantKey);
    const categoryId = learned?.categoryId ?? hist?.categoryId ?? null;
    return {
      categoryId,
      payee: learned?.payeeName ?? hist?.payee ?? cleaned,
      // A refund with no known original category can't net correctly.
      confidence: categoryId ? "high" : "low",
      via: "refund",
      isRefund: true,
    };
  }
  if (looksLikeFeeOrInterest(input.rawDescription)) {
    return {
      categoryId: fallbackCategory,
      payee: cleaned,
      confidence: "high",
      via: "fee",
      isRefund: false,
    };
  }

  // 1. Learned rules (his corrections).
  const learned = input.learnedRules.find((r) => r.merchantKey === key);
  if (learned) {
    return {
      categoryId: learned.categoryId,
      payee: learned.payeeName,
      confidence: "high",
      via: "learned",
      isRefund: false,
    };
  }

  // 2. His history: same merchant -> same category and payee.
  // Thin history (one sighting) outranks generic built-ins but stays
  // low-confidence: he confirms once and it becomes a learned rule.
  const hist = input.history.get(key);
  if (hist) {
    return {
      categoryId: hist.categoryId,
      payee: hist.payee,
      confidence: hist.count >= 2 ? "high" : "low",
      via: "history",
      isRefund: false,
    };
  }

  // 3. Built-in patterns (low confidence: he confirms once).
  const upper = input.rawDescription.toUpperCase();
  for (const rule of BUILTIN_RULES) {
    if (rule.pattern.test(upper)) {
      return {
        categoryId: categoryIdByName(input.categories, rule.category),
        payee: cleaned,
        confidence: "low",
        via: "builtin",
        isRefund: false,
      };
    }
  }

  // 4. Nothing known: needs review.
  return {
    categoryId: null,
    payee: cleaned,
    confidence: "low",
    via: "default",
    isRefund: false,
  };
}

/**
 * Build the merchant history index from existing transactions.
 * Keyed by merchantKey(payee); keeps the most common category/payee.
 */
export function buildMerchantHistory(
  transactions: ReadonlyArray<{ payee: string; categoryId: string | null }>,
): Map<string, MerchantHistory> {
  const votes = new Map<string, Map<string, { categoryId: string; payee: string; count: number }>>();
  for (const t of transactions) {
    if (!t.categoryId || !t.payee.trim()) continue;
    const key = merchantKey(t.payee);
    if (!key) continue;
    let byCat = votes.get(key);
    if (!byCat) {
      byCat = new Map();
      votes.set(key, byCat);
    }
    const voteKey = `${t.categoryId}|${t.payee}`;
    const vote = byCat.get(voteKey) ?? { categoryId: t.categoryId, payee: t.payee, count: 0 };
    vote.count += 1;
    byCat.set(voteKey, vote);
  }
  const out = new Map<string, MerchantHistory>();
  for (const [key, byCat] of votes) {
    let best: MerchantHistory | null = null;
    for (const v of byCat.values()) {
      if (!best || v.count > best.count) best = { categoryId: v.categoryId, payee: v.payee, count: v.count };
    }
    if (best) out.set(key, best);
  }
  return out;
}

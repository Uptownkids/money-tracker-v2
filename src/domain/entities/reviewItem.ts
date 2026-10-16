/**
 * One "Needs review" inbox item (Phase B). Created when the import
 * engine can't confidently categorize or match a row. The transaction
 * already exists and counts toward balances — review only fixes up how
 * it's described, never whether the money moved.
 */
export type ReviewReason =
  | "uncategorized" // no confident category
  | "ambiguous-match" // >1 existing entry could match
  | "transfer-unconfirmed" // self-transfer for an unconfirmed account pair
  | "transfer-unknown-account" // transfer-like, other account not identified
  | "weak-recurring" // possible subscription/bill pattern, not clear enough
  | "refund-unknown-category" // refund with no known original category
  | "price-increase" // recurring charge cost more than the rule amount
  | "missed-charge" // expected recurring charge never arrived (possibly cancelled)
  | "resurrected-merchant"; // new charge from a previously ended merchant

export interface ReviewGuess {
  type: "Expense" | "Income" | "Transfer" | "Refund";
  categoryId?: string;
  payee?: string;
  /** Best-guess destination for a transfer. */
  transferToAccountId?: string;
  /** Suggested bill name when this looks like a bill charge. */
  billName?: string;
}

export type ReviewStatus = "open" | "resolved" | "ignored";

export interface ReviewItem {
  id: string;
  transactionId: string;
  reasons: ReviewReason[];
  guess: ReviewGuess;
  /** Merchant key, for "always do this for [merchant]". */
  merchantKey: string;
  status: ReviewStatus;
  createdAt: string;
  resolvedAt?: string;
}

/**
 * Permanent record of every bank row the importer has seen, keyed by its
 * fingerprint. This is what makes duplicate checking work across files
 * and across re-imports: a row whose fingerprint is already here is never
 * imported twice, whatever file it arrives in.
 */
export type BankRowOutcome =
  | "imported" // created a new transaction
  | "duplicate" // fingerprint already seen; skipped
  | "matched" // linked to a manually-logged entry (marked Cleared)
  | "bill-settled" // settled a Scheduled bill row in place
  | "transfer-absorbed" // second side of a paired transfer; no new row
  | "pending"; // imported as Pending (live sync); may update on posting

export interface BankFingerprint {
  /** Unique key: stable bank id or fp:<hash>. */
  fingerprint: string;
  /** The ledger transaction this row resolved to (null only if none). */
  transactionId: string | null;
  /** Batch that processed the row. */
  batchId: string;
  outcome: BankRowOutcome;
  createdAt: string;
}

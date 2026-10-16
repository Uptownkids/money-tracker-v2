/**
 * Stable identity for imported bank rows (Phase A/B).
 *
 * Wells Fargo CSVs may carry no transaction id at all. Identity is then a
 * fingerprint of account + date + amount + normalized description. Two
 * identical same-day transactions CAN both be real, so the fingerprint
 * alone never decides "duplicate" — the import planner compares COUNTS:
 * if the incoming set has 2 rows with fingerprint F and the ledger
 * already has 1, exactly 1 is imported.
 *
 * A Zelle Ref # (when present) is a stable bank transaction id and is
 * used directly, namespaced as `zelle:<REF>`.
 */
import type { DateOnly } from "../dates/dateOnly.js";
import type { MinorUnits } from "../money/money.js";

/**
 * Normalize a bank description for fingerprinting and merchant matching:
 * uppercase, strip Zelle's embedded date and Ref # (the description date
 * can differ from the posting date), collapse whitespace/punctuation.
 */
export function normalizeDescription(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/\bON\s+\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "")
    .replace(/\bREF\s*#\s*[A-Z0-9-]+\b/g, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** FNV-1a 32-bit hash, hex-encoded. Deterministic, non-crypto. */
export function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface FingerprintInput {
  accountId: string;
  date: DateOnly;
  /** Signed minor units. Sign matters: in vs out are different rows. */
  amountMinor: MinorUnits;
  /** Raw bank description (normalized internally). */
  description: string;
  /** Stable bank id when the row carries one (e.g. Zelle Ref #). */
  stableId?: string;
}

/**
 * Deterministic fingerprint for one bank row. Stable ids win outright;
 * otherwise hash(account | date | amount | normalized description).
 */
export function bankRowFingerprint(input: FingerprintInput): string {
  if (input.stableId) return input.stableId;
  const norm = normalizeDescription(input.description);
  return `fp:${fnv1aHex(`${input.accountId}|${input.date}|${input.amountMinor}|${norm}`)}`;
}

/**
 * Collapse identical fingerprints that arrive in DIFFERENT files of one
 * import (overlapping exports): only the first file's copy is kept.
 * Identical rows within the SAME file are left alone — two identical
 * same-day transactions can both be real, and the count-based ledger
 * check decides those. Returns the items to drop.
 */
export function collapseCrossFileDuplicates<T>(
  items: readonly T[],
  fingerprintOf: (item: T) => string,
  fileOf: (item: T) => string,
): Set<T> {
  const firstFile = new Map<string, string>();
  const dropped = new Set<T>();
  for (const item of items) {
    const fp = fingerprintOf(item);
    const seen = firstFile.get(fp);
    if (seen === undefined) firstFile.set(fp, fileOf(item));
    else if (seen !== fileOf(item)) dropped.add(item);
  }
  return dropped;
}

/**
 * Count-based dedup plan. Groups incoming fingerprints; for each group,
 * `alreadyImported` rows are skipped and the rest are kept. Incoming
 * rows that share a fingerprint are indistinguishable, so the FIRST
 * `alreadyImported` rows (in file order) are the skipped ones.
 */
export interface DedupPlan<T> {
  /** Rows to import, in original order. */
  keep: T[];
  /** Rows skipped as duplicates, in original order. */
  skipped: T[];
}

export function planDedup<T>(
  items: readonly T[],
  fingerprintOf: (item: T) => string,
  alreadyCountOf: (fingerprint: string) => number,
): DedupPlan<T> {
  const seenInBatch = new Map<string, number>();
  const keep: T[] = [];
  const skipped: T[] = [];
  for (const item of items) {
    const fp = fingerprintOf(item);
    const already = alreadyCountOf(fp);
    const seen = seenInBatch.get(fp) ?? 0;
    seenInBatch.set(fp, seen + 1);
    if (seen < already) skipped.push(item);
    else keep.push(item);
  }
  return { keep, skipped };
}

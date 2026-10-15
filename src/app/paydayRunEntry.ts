/**
 * Payday Run entry-point resolution.
 *
 * Both entry points (the Dashboard banner and the Bills tab button) hand
 * the PaydayRun screen a pay date; this resolves that date to the primary
 * payday rule and its occurrence. The screen needs the CANONICAL
 * occurrence date (pre-shift, pre-override) because that is the identity
 * key on generated Scheduled rows — while callers may hand us either the
 * canonical date (Bills tab) or the shifted payment date (Dashboard
 * banner, which uses enumeratePaydays). Matching on both keeps both
 * entry points working when a weekend shift moves the payday.
 */
import type { DateOnly } from "../domain/dates/dateOnly.js";
import { addDays } from "../domain/dates/dateOnly.js";
import {
  enumerateOccurrences,
  type GeneratedOccurrence,
} from "../domain/engine/recurringEngine.js";
import { getActiveDb } from "../data/db.js";
import { createRepositories } from "../data/repositories/index.js";

export interface PaydayRunTarget {
  ruleId: string;
  occurrenceDate: DateOnly;
  payDate: DateOnly;
}

/**
 * Pure: find the occurrence a pay date refers to. Matches the shifted
 * payment date first, then the canonical occurrence date.
 */
export function findPaydayOccurrence(
  occurrences: readonly GeneratedOccurrence[],
  payDate: DateOnly,
): GeneratedOccurrence | null {
  return (
    occurrences.find((o) => o.date === payDate || o.occurrenceDate === payDate) ??
    null
  );
}

/** Resolve a pay date to its primary payday rule + canonical occurrence, or null. */
export async function resolvePaydayRunTarget(
  payDate: DateOnly,
): Promise<PaydayRunTarget | null> {
  const repos = createRepositories(getActiveDb());
  const rules = await repos.recurringRules.active();
  const primary = rules.find((r) => r.kind === "Income" && r.isPrimaryPayday) ?? null;
  if (!primary) return null;
  const overrides = await repos.recurringOverrides.byRule(primary.id);
  const occurrences = enumerateOccurrences(
    primary,
    overrides,
    addDays(payDate, -10),
    addDays(payDate, 10),
  );
  const occurrence = findPaydayOccurrence(occurrences, payDate);
  if (!occurrence) return null;
  return { ruleId: primary.id, occurrenceDate: occurrence.occurrenceDate, payDate };
}

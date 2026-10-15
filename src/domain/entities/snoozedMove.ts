import type { DateOnly } from "../dates/dateOnly.js";

/**
 * A Today's Move the user snoozed. Keyed by the move's stable id
 * (e.g. `move:p:<ruleId>:<occurrenceDate>`). The move stays hidden while
 * `snoozedUntil >= today`, so a snooze set today hides the move today
 * and it returns tomorrow. Expired rows are garbage-collected on
 * dashboard load.
 */
export interface SnoozedMove {
  /** The move id, e.g. `move:p:rule-1:2026-10-15`. */
  moveId: string;
  /** Hide the move through this date (inclusive). */
  snoozedUntil: DateOnly;
}

/**
 * Duplicate-ID protection for the private inbox. Applied entry IDs are
 * persisted on the settings row, so an entry can never be applied twice —
 * not by double-tap, not across restarts, not after a backup restore.
 */
import type { Repositories } from "./repositories/index.js";
import type { Settings } from "../domain/entities/settings.js";

/** All applied inbox entry IDs (empty when none). */
export async function getAppliedInboxIds(repos: Repositories): Promise<string[]> {
  const settings = await repos.settings.get();
  return settings?.appliedInboxIds ?? [];
}

/** True when this inbox entry was already approved. */
export async function isInboxEntryApplied(
  repos: Repositories,
  id: string,
): Promise<boolean> {
  const ids = await getAppliedInboxIds(repos);
  return ids.includes(id);
}

/**
 * Record an inbox entry as applied. Idempotent: marking twice keeps a
 * single copy of the id. Creates the settings row when missing so the
 * mark can never be silently dropped.
 */
export async function markInboxEntryApplied(
  repos: Repositories,
  id: string,
): Promise<void> {
  const existing = await repos.settings.get();
  const base: Settings = existing ?? {
    id: "settings",
    baseCurrency: "USD",
    bufferAmount: 0,
    theme: "system",
    notificationsEnabled: false,
    onboardingCompleted: true,
  };
  const ids = base.appliedInboxIds ?? [];
  if (ids.includes(id)) return;
  await repos.settings.save({ ...base, appliedInboxIds: [...ids, id] });
}

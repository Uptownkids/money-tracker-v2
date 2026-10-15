/**
 * Atomic import of a MigrationResult into a MoneyTracker database.
 *
 * Everything happens inside ONE Dexie transaction: the existing settings
 * row is read first, every table is cleared, then each table's rows are
 * written. If any write throws, the whole import rolls back and the
 * database is left untouched — no partial import is possible.
 *
 * The settings merge preserves markOnboardingComplete semantics: the
 * existing row is kept and gains onboardingCompleted: true, or the
 * default settings row (with the flag) is created when none exists.
 */
import type { MoneyTrackerDB } from "../db.js";
import type { MigrationResult } from "./fromV1.js";

export async function importMigratedResult(
  db: MoneyTrackerDB,
  migrated: MigrationResult,
): Promise<void> {
  await db.transaction(
    "rw",
    [db.accounts, db.categories, db.transactions, db.recurringRules, db.goals, db.splits, db.settings],
    async () => {
      // Read before clearing so the merge below can preserve it.
      const existingSettings = await db.settings.get("settings");

      await db.accounts.clear();
      await db.categories.clear();
      await db.transactions.clear();
      await db.recurringRules.clear();
      await db.goals.clear();
      await db.splits.clear();
      await db.settings.clear();

      await db.accounts.bulkPut(migrated.accounts);
      await db.categories.bulkPut(migrated.categories);
      await db.transactions.bulkPut(migrated.transactions);
      await db.recurringRules.bulkPut(migrated.recurringRules);
      await db.goals.bulkPut(migrated.goals);
      await db.splits.bulkPut(migrated.splits);

      if (existingSettings) {
        await db.settings.put({ ...existingSettings, onboardingCompleted: true });
      } else {
        await db.settings.put({
          id: "settings",
          baseCurrency: "USD",
          bufferAmount: 0,
          theme: "system",
          notificationsEnabled: false,
          onboardingCompleted: true,
        });
      }
    },
  );
}

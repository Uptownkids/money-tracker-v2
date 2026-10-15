/**
 * Local bill reminders. There is no push server: notifications only fire
 * while the app is open (best effort, never throws). The coordinator
 * calls maybeNotifyUpcomingBills on app launch.
 */
import type { Repositories } from "../data/repositories/index.js";
import { addDays, todayLocal } from "../domain/dates/dateOnly.js";

/**
 * If notifications are enabled and permission is granted, fire one
 * summary notification for Scheduled bills due within the next 24 hours.
 * Returns true when a notification was shown.
 */
export async function maybeNotifyUpcomingBills(repos: Repositories): Promise<boolean> {
  try {
    const settings = await repos.settings.get();
    if (!settings?.notificationsEnabled) return false;
    if (typeof Notification === "undefined") return false;
    if (Notification.permission !== "granted") return false;

    const today = todayLocal();
    const tomorrow = addDays(today, 1);
    const scheduled = await repos.transactions.byStatus("Scheduled");
    const dueSoon = scheduled.filter(
      (t) => t.type !== "Income" && t.date >= today && t.date <= tomorrow,
    );
    if (dueSoon.length === 0) return false;

    dueSoon.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const listed = dueSoon.slice(0, 3).map((t) => t.payee);
    const rest = dueSoon.length - listed.length;
    const title =
      dueSoon.length === 1 ? "1 bill due soon" : `${dueSoon.length} bills due soon`;
    const body =
      listed.join(", ") + (rest > 0 ? ` and ${rest} more` : "") + ". Due by tomorrow.";

    new Notification(title, { body });
    return true;
  } catch {
    // Best effort: a failed notification must never break app launch.
    return false;
  }
}

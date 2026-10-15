import type { DateOnly } from "../dates/dateOnly.js";
import type { MinorUnits } from "../money/money.js";

export interface Goal {
  id: string;
  name: string;
  targetAmount: MinorUnits;
  currency: string;
  // Optional: a dateless goal gets a 1-year planning horizon for
  // contribution math (see goalTargetDateOrDefault) and shows
  // "No target date" in the UI.
  targetDate?: DateOnly;
  linkedSavingsAccountId?: string;
  // Amount saved is NOT stored. It is always derived by summing
  // transactions with this goalId, consistent with "nothing calculated
  // twice." Contribution per cycle is likewise derived from the derived
  // saved amount, remaining amount, and pay cycles left before the
  // target date; the override below replaces the derived value when set.
  contributionPerCycleOverride?: MinorUnits;
  // Pinned contribution for the current pay cycle. At the start of each
  // cycle the contribution is computed from the funded amount as of the
  // cycle's start date (funding transactions dated before the cycle
  // start; goal-tagged spending counts as used, never unsaved) and pinned
  // here. Mid-cycle funding does not change it. Null
  // when not yet pinned for the current cycle. The calculator uses the
  // pinned amount when pinnedContribution.cycleStart equals the current
  // cycle's start date; otherwise it computes and pins a fresh value.
  pinnedContribution: { cycleStart: DateOnly; amount: MinorUnits } | null;
  // Deficit pause order is stored here, not as named goals in the
  // calculator. Lower number = suggested for pausing first in deficit.
  // Example values: Extra debt payoff = 1, Emergency fund = 2,
  // LA trip float = 3.
  priority: number;
  paused: boolean;
  // A completed goal is done: no more contributions, no commitments, and
  // it never appears in Today's Moves. It stays visible (badged as
  // completed) in Insights and the Goals tab. Legacy rows predate the
  // field and read as undefined, which is falsy — same as `paused`.
  completed: boolean;
  createdAt: string;
  updatedAt: string;
}

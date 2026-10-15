import { describe, expect, it } from "vitest";
import {
  completePaydayRun,
  createPaydayRunState,
  nextIncompleteStep,
} from "../src/domain/engine/paydayRun.js";
import type { PaydayRunState } from "../src/domain/entities/settings.js";

const NOW = "2026-10-15T12:00:00.000Z";

function stepState(over: Partial<PaydayRunState["steps"]>): PaydayRunState["steps"] {
  return { billsSetAside: false, goalContributions: {}, goalsStepDone: false, cardPaymentDone: false, ...over };
}

describe("nextIncompleteStep", () => {
  it("returns 1 for a fresh run", () => {
    const run = createPaydayRunState("2026-10-15", 226341, NOW);
    expect(nextIncompleteStep(run)).toBe(1);
  });

  it("returns 2 once the paycheck is confirmed", () => {
    const run: PaydayRunState = {
      ...createPaydayRunState("2026-10-15", 226341, NOW),
      confirmedAmount: 226341,
    };
    expect(nextIncompleteStep(run)).toBe(2);
  });

  it("returns 3 once bills are set aside", () => {
    const run: PaydayRunState = {
      ...createPaydayRunState("2026-10-15", 226341, NOW),
      confirmedAmount: 226341,
      steps: stepState({ billsSetAside: true }),
    };
    expect(nextIncompleteStep(run)).toBe(3);
  });

  it("returns 4 once the goals step is done, even when some goals are unfunded", () => {
    // The goals step is skippable: goalsStepDone (user pressed Continue)
    // is what completes it, not funding every goal.
    const run: PaydayRunState = {
      ...createPaydayRunState("2026-10-15", 226341, NOW),
      confirmedAmount: 226341,
      steps: stepState({
        billsSetAside: true,
        goalsStepDone: true,
        goalContributions: { "goal-a": true },
      }),
    };
    expect(nextIncompleteStep(run)).toBe(4);
  });

  it("does not treat partially funded goals as completing the goals step", () => {
    const run: PaydayRunState = {
      ...createPaydayRunState("2026-10-15", 226341, NOW),
      confirmedAmount: 226341,
      steps: stepState({
        billsSetAside: true,
        goalContributions: { "goal-a": true, "goal-b": true },
      }),
    };
    expect(nextIncompleteStep(run)).toBe(3);
  });

  it("returns 5 once the card step is addressed", () => {
    const run: PaydayRunState = {
      ...createPaydayRunState("2026-10-15", 226341, NOW),
      confirmedAmount: 226341,
      steps: stepState({
        billsSetAside: true,
        goalsStepDone: true,
        cardPaymentDone: true,
      }),
    };
    expect(nextIncompleteStep(run)).toBe(5);
  });

  it("returns 5 for a completed run (caller renders the summary)", () => {
    const run = completePaydayRun(
      {
        ...createPaydayRunState("2026-10-15", 226341, NOW),
        confirmedAmount: 226341,
        steps: stepState({
          billsSetAside: true,
          goalsStepDone: true,
          cardPaymentDone: true,
        }),
      },
      NOW,
    );
    expect(run.completed).toBe(true);
    expect(nextIncompleteStep(run)).toBe(5);
  });

  it("a confirmedAmount of 0 still counts as step 1 done", () => {
    const run: PaydayRunState = {
      ...createPaydayRunState("2026-10-15", 226341, NOW),
      confirmedAmount: 0,
    };
    expect(nextIncompleteStep(run)).toBe(2);
  });
});

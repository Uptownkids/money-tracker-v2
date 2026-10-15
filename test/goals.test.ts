import { describe, expect, it } from "vitest";
import {
  computeCycleContribution,
  goalTargetDateOrDefault,
} from "../src/domain/engine/goals.js";
import { mkGoal } from "./helpers.js";

describe("goalTargetDateOrDefault", () => {
  it("returns the set date when present", () => {
    const goal = mkGoal({ targetDate: "2027-06-30" });
    expect(goalTargetDateOrDefault(goal, "2026-10-15")).toBe("2027-06-30");
  });

  it("returns cycleStart + 365 days when no target date is set", () => {
    const goal = mkGoal({ targetDate: undefined });
    expect(goalTargetDateOrDefault(goal, "2026-10-15")).toBe("2027-10-15");
  });
});

describe("computeCycleContribution with the defaulted horizon", () => {
  it("spreads the remaining amount evenly (120000 target, 0 saved, 12 cycles -> 10000)", () => {
    const goal = mkGoal({
      targetAmount: 120000,
      contributionPerCycleOverride: undefined,
    });
    expect(computeCycleContribution(goal, 0, 12)).toBe(10000);
  });

  it("ceiling-divides a non-even remainder so the target stays reachable", () => {
    const goal = mkGoal({
      targetAmount: 10000,
      contributionPerCycleOverride: undefined,
    });
    expect(computeCycleContribution(goal, 0, 3)).toBe(3334);
  });

  it("honors a partially-saved amount against the horizon", () => {
    const goal = mkGoal({
      targetAmount: 120000,
      contributionPerCycleOverride: undefined,
    });
    expect(computeCycleContribution(goal, 30000, 12)).toBe(7500);
  });

  it("uses the 1-year default horizon for a dateless goal", () => {
    const goal = mkGoal({
      targetAmount: 120000,
      targetDate: undefined,
      contributionPerCycleOverride: undefined,
    });
    expect(goalTargetDateOrDefault(goal, "2026-10-15")).toBe("2027-10-15");
  });

  it("override wins over the derived spread", () => {
    const goal = mkGoal({
      targetAmount: 120000,
      contributionPerCycleOverride: 500,
    });
    expect(computeCycleContribution(goal, 0, 12)).toBe(500);
  });
});

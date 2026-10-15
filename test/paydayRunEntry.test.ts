import { describe, expect, it } from "vitest";
import { findPaydayOccurrence } from "../src/app/paydayRunEntry.js";
import type { GeneratedOccurrence } from "../src/domain/engine/recurringEngine.js";
import type { DateOnly } from "../src/domain/dates/dateOnly.js";

const occ = (occurrenceDate: DateOnly, date: DateOnly): GeneratedOccurrence => ({
  ruleId: "r-pay",
  occurrenceDate,
  date,
  amount: 226341,
});

describe("findPaydayOccurrence", () => {
  it("matches the shifted payment date and returns the canonical occurrence", () => {
    // Payday falls on Sunday the 15th, shifted to Friday the 13th.
    const occs = [occ("2026-11-15" as DateOnly, "2026-11-13" as DateOnly)];
    const found = findPaydayOccurrence(occs, "2026-11-13" as DateOnly);
    expect(found?.occurrenceDate).toBe("2026-11-15");
  });

  it("matches the canonical occurrence date directly", () => {
    const occs = [occ("2026-11-15" as DateOnly, "2026-11-13" as DateOnly)];
    const found = findPaydayOccurrence(occs, "2026-11-15" as DateOnly);
    expect(found?.occurrenceDate).toBe("2026-11-15");
  });

  it("returns null when the date matches no occurrence", () => {
    const occs = [occ("2026-11-15" as DateOnly, "2026-11-13" as DateOnly)];
    expect(findPaydayOccurrence(occs, "2026-11-20" as DateOnly)).toBeNull();
    expect(findPaydayOccurrence([], "2026-11-13" as DateOnly)).toBeNull();
  });
});

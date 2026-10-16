/** Pending -> posted reconciliation tests (Phase B, built for live sync). */
import { describe, expect, it } from "vitest";
import {
  applyPostedToPending,
  findVanishedPending,
  matchPendingToPosted,
} from "../src/domain/import/pendingSync.js";
import { mkTransaction } from "./helpers.js";

const pending = (o: Record<string, unknown> = {}) =>
  mkTransaction({
    id: "pend-1",
    status: "Pending",
    accountId: "acct-checking",
    date: "2026-10-14",
    amount: 2500,
    payee: "COFFEE SHOP",
    ...o,
  });

describe("matchPendingToPosted", () => {
  it("matches on the stable id even when the amount changed (tip added)", () => {
    const p = pending({ bankFingerprint: "zelle:111" });
    const row = { date: "2026-10-15", amountMinor: 2800, description: "COFFEE SHOP", stableId: "zelle:111" } as const;
    expect(matchPendingToPosted([p], row, "acct-checking")?.id).toBe("pend-1");
  });

  it("matches on description + date window without a stable id", () => {
    const p = pending();
    const row = { date: "2026-10-16", amountMinor: 2500, description: "coffee shop" } as const;
    expect(matchPendingToPosted([p], row, "acct-checking")?.id).toBe("pend-1");
  });

  it("refuses to guess when two pendings could match", () => {
    const rows = [pending({ id: "a" }), pending({ id: "b" })];
    const row = { date: "2026-10-15", amountMinor: 2500, description: "COFFEE SHOP" } as const;
    expect(matchPendingToPosted(rows, row, "acct-checking")).toBeNull();
  });

  it("ignores pendings from other accounts", () => {
    const p = pending();
    const row = { date: "2026-10-15", amountMinor: 2500, description: "COFFEE SHOP" } as const;
    expect(matchPendingToPosted([p], row, "acct-other")).toBeNull();
  });
});

describe("applyPostedToPending", () => {
  it("updates the same row in place: Cleared, new amount and date", () => {
    const p = pending();
    const row = { date: "2026-10-15", amountMinor: 2800, description: "COFFEE SHOP" } as const;
    const result = applyPostedToPending([p], row, "acct-checking", "2026-10-15T12:00:00.000Z");
    expect(result?.updated).toMatchObject({ id: "pend-1", status: "Cleared", amount: 2800, date: "2026-10-15" });
    expect(result?.summary).toMatchObject({ amountChanged: true, oldAmount: 2500, newAmount: 2800 });
  });

  it("returns null when nothing matches (caller imports a new row)", () => {
    const row = { date: "2026-10-15", amountMinor: 2800, description: "NOPE" } as const;
    expect(applyPostedToPending([pending()], row, "acct-checking", "2026-10-15T12:00:00.000Z")).toBeNull();
  });
});

describe("findVanishedPending", () => {
  it("flags old pendings with no posted counterpart", () => {
    const old = pending({ id: "old", date: "2026-09-01" });
    const fresh = pending({ id: "fresh", date: "2026-10-15" });
    const vanished = findVanishedPending([old, fresh], [], "acct-checking", "2026-10-16");
    expect(vanished.map((t) => t.id)).toEqual(["old"]);
  });

  it("keeps pendings that still match a posted row", () => {
    const p = pending({ date: "2026-09-01" });
    const rows = [{ date: "2026-09-02", amountMinor: 2500, description: "COFFEE SHOP" }] as const;
    expect(findVanishedPending([p], rows, "acct-checking", "2026-10-16")).toEqual([]);
  });
});

/** Private inbox: parsing, fetch errors, duplicate-ID protection, stale warnings, token expiry. */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { MoneyTrackerDB } from "../src/data/db.js";
import { createRepositories } from "../src/data/repositories/index.js";
import {
  getAppliedInboxIds,
  isInboxEntryApplied,
  markInboxEntryApplied,
} from "../src/data/inbox.js";
import {
  decodeInboxPayload,
  fetchInbox,
  inboxAdjustToIntent,
  inboxTokenStatus,
  parseInboxFile,
  staleInboxEntries,
  validateInboxTokenSave,
  type InboxEntry,
} from "../src/utils/inbox.js";
import { decideAdjust } from "../src/utils/deepLink.js";
import type { DateOnly } from "../src/domain/dates/dateOnly.js";
import type { MinorUnits } from "../src/domain/money/money.js";

const TODAY = "2026-10-15" as DateOnly;

const expenseEntry = (over: Partial<InboxEntry> = {}): InboxEntry => ({
  id: "e1",
  kind: "expense",
  amount: 12.5,
  payee: "Chipotle",
  account: "Cash",
  date: "2026-10-15",
  ...over,
});

const b64 = (s: string) => btoa(s);

describe("parseInboxFile", () => {
  it("accepts a valid file with expense, income, and adjust entries", () => {
    const r = parseInboxFile({
      entries: [
        expenseEntry(),
        expenseEntry({ id: "e2", kind: "income", amount: 2263.41, payee: "Paycheck" }),
        { id: "e3", kind: "adjust", account: "Checking", date: "2026-10-15", balance: 30 },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entries).toHaveLength(3);
  });

  it("accepts an empty entries array", () => {
    expect(parseInboxFile({ entries: [] })).toEqual({ ok: true, entries: [] });
  });

  it("rejects a non-object file", () => {
    expect(parseInboxFile(null).ok).toBe(false);
    expect(parseInboxFile([1, 2]).ok).toBe(false);
  });

  it("rejects a missing entries array", () => {
    const r = parseInboxFile({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/entries/);
  });

  it("rejects an unknown kind for the whole file", () => {
    const r = parseInboxFile({ entries: [expenseEntry({ kind: "transfer" as never })] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown kind/);
  });

  it("rejects one bad entry without skipping it", () => {
    const r = parseInboxFile({
      entries: [expenseEntry(), expenseEntry({ id: "bad", amount: -5 })],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/entry #2/);
  });

  it("rejects missing id, empty payee, bad date", () => {
    expect(parseInboxFile({ entries: [{ ...expenseEntry(), id: "" }] }).ok).toBe(false);
    expect(parseInboxFile({ entries: [{ ...expenseEntry(), payee: "  " }] }).ok).toBe(false);
    expect(parseInboxFile({ entries: [{ ...expenseEntry(), date: "2026-13-01" }] }).ok).toBe(false);
    expect(parseInboxFile({ entries: [{ ...expenseEntry(), date: "2026-02-30" }] }).ok).toBe(false);
  });

  it("rejects adjust entries missing account or balance", () => {
    expect(
      parseInboxFile({ entries: [{ id: "a", kind: "adjust", date: "2026-10-15", balance: 10 }] }).ok,
    ).toBe(false);
    expect(
      parseInboxFile({ entries: [{ id: "a", kind: "adjust", account: "Cash", date: "2026-10-15" }] }).ok,
    ).toBe(false);
    expect(
      parseInboxFile({
        entries: [{ id: "a", kind: "adjust", account: "Cash", date: "2026-10-15", balance: -1 }],
      }).ok,
    ).toBe(false);
  });

  it("allows zero balance on adjust", () => {
    const r = parseInboxFile({
      entries: [{ id: "a", kind: "adjust", account: "Cash", date: "2026-10-15", balance: 0 }],
    });
    expect(r.ok).toBe(true);
  });
});

describe("decodeInboxPayload", () => {
  it("decodes a GitHub contents payload", () => {
    const r = decodeInboxPayload({ content: b64(JSON.stringify({ entries: [expenseEntry()] })) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entries[0]?.id).toBe("e1");
  });

  it("rejects missing content", () => {
    expect(decodeInboxPayload({}).ok).toBe(false);
  });

  it("rejects invalid base64", () => {
    expect(decodeInboxPayload({ content: "!!!not-base64!!!" }).ok).toBe(false);
  });

  it("rejects base64 that isn't JSON", () => {
    expect(decodeInboxPayload({ content: b64("hello") }).ok).toBe(false);
  });
});

describe("fetchInbox", () => {
  const okFetch = (payload: unknown) => async () => ({
    status: 200,
    json: async () => payload,
  });

  it("returns entries on success", async () => {
    const r = await fetchInbox(
      "tok",
      okFetch({ content: b64(JSON.stringify({ entries: [expenseEntry()] })) }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entries).toHaveLength(1);
  });

  it("maps network failure to a network error", async () => {
    const r = await fetchInbox("tok", async () => {
      throw new Error("down");
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("network");
  });

  it("maps 401 and 403 to auth errors", async () => {
    for (const status of [401, 403]) {
      const r = await fetchInbox("tok", async () => ({ status, json: async () => ({}) }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("auth");
    }
  });

  it("maps other HTTP errors distinctly", async () => {
    const r = await fetchInbox("tok", async () => ({ status: 500, json: async () => ({}) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("http");
  });

  it("maps a malformed file to a malformed error, never partial entries", async () => {
    const r = await fetchInbox(
      "tok",
      okFetch({ content: b64(JSON.stringify({ entries: [expenseEntry({ amount: 0 })] })) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("malformed");
  });
});

describe("duplicate-ID protection", () => {
  let db: MoneyTrackerDB;
  afterEach(async () => {
    await db?.delete();
  });

  const repos = () => {
    db = new MoneyTrackerDB(`test-inbox-${Date.now()}-${Math.random()}`);
    return createRepositories(db);
  };

  it("starts empty, marks applied, and blocks re-apply", async () => {
    const r = repos();
    expect(await isInboxEntryApplied(r, "e1")).toBe(false);
    await markInboxEntryApplied(r, "e1");
    expect(await isInboxEntryApplied(r, "e1")).toBe(true);
    expect(await getAppliedInboxIds(r)).toEqual(["e1"]);
  });

  it("marking twice is idempotent", async () => {
    const r = repos();
    await markInboxEntryApplied(r, "e1");
    await markInboxEntryApplied(r, "e1");
    expect(await getAppliedInboxIds(r)).toEqual(["e1"]);
  });

  it("creates the settings row when missing", async () => {
    const r = repos();
    await markInboxEntryApplied(r, "e9");
    expect(await isInboxEntryApplied(r, "e9")).toBe(true);
  });
});

describe("staleInboxEntries", () => {
  const entry = (id: string, date: string): InboxEntry =>
    expenseEntry({ id, date: date as DateOnly });

  it("flags entries older than 60 days", () => {
    const old = entry("old", "2026-08-14"); // 62 days before 2026-10-15
    const recent = entry("new", "2026-10-01");
    const stale = staleInboxEntries([old, recent], [], TODAY);
    expect(stale.map((e) => e.id)).toEqual(["old"]);
  });

  it("59 and 60 days are not stale; 61 is", () => {
    const d59 = entry("d59", "2026-08-17");
    const d60 = entry("d60", "2026-08-16");
    const d61 = entry("d61", "2026-08-15");
    const stale = staleInboxEntries([d59, d60, d61], [], TODAY);
    expect(stale.map((e) => e.id)).toEqual(["d61"]);
  });

  it("excludes already-applied entries", () => {
    const old = entry("old", "2026-08-14");
    expect(staleInboxEntries([old], ["old"], TODAY)).toHaveLength(0);
  });

  it("falls back to createdAt when date is unusable", () => {
    const e = { ...entry("c", "2026-10-15"), date: "bad" as DateOnly, createdAt: "2026-08-01T00:00:00Z" };
    expect(staleInboxEntries([e], [], TODAY).map((x) => x.id)).toEqual(["c"]);
  });

  it("createdAt wins over date: a backdated entry submitted today is not stale", () => {
    const e = {
      ...entry("fresh", "2026-01-01"),
      createdAt: "2026-10-15T12:00:00Z",
    };
    expect(staleInboxEntries([e], [], TODAY)).toHaveLength(0);
  });

  it("an entry enqueued 61 days ago is stale even with a recent transaction date", () => {
    const e = {
      ...entry("old-enqueue", "2026-10-15"),
      createdAt: "2026-08-15T12:00:00Z",
    };
    expect(staleInboxEntries([e], [], TODAY).map((x) => x.id)).toEqual(["old-enqueue"]);
  });
});

describe("inboxTokenStatus", () => {
  it("missing token hides the inbox", () => {
    expect(inboxTokenStatus(null, null, TODAY)).toBe("missing");
    expect(inboxTokenStatus("  ", null, TODAY)).toBe("missing");
  });

  it("no expiry date means ok", () => {
    expect(inboxTokenStatus("tok", null, TODAY)).toBe("ok");
  });

  it("expired token is expired", () => {
    expect(inboxTokenStatus("tok", "2026-10-14" as DateOnly, TODAY)).toBe("expired");
  });

  it("13 and 14 days out warn; 15 days is ok", () => {
    expect(inboxTokenStatus("tok", "2026-10-28" as DateOnly, TODAY)).toBe("expiring");
    expect(inboxTokenStatus("tok", "2026-10-29" as DateOnly, TODAY)).toBe("expiring");
    expect(inboxTokenStatus("tok", "2026-10-30" as DateOnly, TODAY)).toBe("ok");
  });

  it("expiry today warns, not expired", () => {
    expect(inboxTokenStatus("tok", TODAY, TODAY)).toBe("expiring");
  });
});

describe("validateInboxTokenSave", () => {
  it("clearing the token needs no expiry", () => {
    expect(validateInboxTokenSave("", "")).toBe(null);
    expect(validateInboxTokenSave("   ", "")).toBe(null);
  });

  it("saving a token requires an expiry date", () => {
    expect(validateInboxTokenSave("tok", "")).toMatch(/expiry date/);
  });

  it("rejects a malformed expiry date", () => {
    expect(validateInboxTokenSave("tok", "next year")).toMatch(/YYYY-MM-DD/);
  });

  it("accepts a token with a valid expiry date", () => {
    expect(validateInboxTokenSave("tok", "2027-10-15")).toBe(null);
  });
});

describe("inbox adjust entries reuse the shared adjust flow", () => {
  it("builds the same AdjustIntent a ?adjust= link produces", () => {
    const entry: InboxEntry = {
      id: "a1",
      kind: "adjust",
      account: "Checking",
      date: TODAY,
      balance: 30,
    };
    expect(inboxAdjustToIntent(entry)).toEqual({
      kind: "adjust",
      accountName: "Checking",
      balanceText: "30",
    });
  });

  it("the intent feeds decideAdjust identically", () => {
    const intent = inboxAdjustToIntent({
      id: "a1",
      kind: "adjust",
      account: "Checking",
      date: TODAY,
      balance: 30,
    });
    const d = decideAdjust({
      accountType: "Checking",
      appBalanceMinor: 10000 as MinorUnits,
      statedText: intent.balanceText,
      currency: "USD",
    });
    expect(d).toEqual({ kind: "unlogged-spending", differenceMinor: 7000 });
  });
});

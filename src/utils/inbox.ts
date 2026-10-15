/**
 * Private inbox: entries Rocky writes to the private money-inbox repo,
 * which Malike approves on his phone. The phone NEVER uploads anything —
 * fetch is GET-only; balances and history stay on device.
 *
 * Entry kinds:
 *   expense | income — amount, payee, account, date (+ optional note)
 *   adjust           — account + stated balance (>= 0); approving runs the
 *                      same balance-correction flow as the ?adjust= link.
 *
 * Parsing is strict: one malformed entry fails the WHOLE fetch with a
 * named error. Entries are never silently skipped and never partially
 * applied. Pruning (90 days) is the writer's job; the app never deletes
 * inbox entries.
 */
import { isDateOnly, type DateOnly } from "../domain/dates/dateOnly.js";
import type { AdjustIntent } from "./deepLink.js";

export const INBOX_API_URL =
  "https://api.github.com/repos/Uptownkids/money-inbox/contents/inbox.json";

const TOKEN_KEY = "moneyTracker.inboxToken";
const TOKEN_EXPIRY_KEY = "moneyTracker.inboxTokenExpiry";

export type InboxEntryKind = "expense" | "income" | "adjust";

export interface InboxEntry {
  id: string;
  kind: InboxEntryKind;
  /** Dollars as a JSON number; required for expense/income. */
  amount?: number;
  payee?: string;
  /** Account name as written by the writer; resolved against real accounts at approve time. */
  account: string;
  date: DateOnly;
  note?: string;
  createdAt?: string;
  /** Stated balance in dollars; required for adjust. */
  balance?: number;
}

export type InboxParseResult =
  | { ok: true; entries: InboxEntry[] }
  | { ok: false; error: string };

export type InboxFetchErrorKind = "network" | "auth" | "http" | "malformed";

export interface InboxFetchError {
  kind: InboxFetchErrorKind;
  message: string;
}

export type InboxFetchResult =
  | { ok: true; entries: InboxEntry[] }
  | { ok: false; error: InboxFetchError };

const fail = (error: string): InboxParseResult => ({ ok: false, error });

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function checkEntry(raw: unknown, index: number): string | null {
  const where = `entry #${index + 1}`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return `${where} isn't an object`;
  }
  const e = raw as Record<string, unknown>;
  if (!isNonEmptyString(e.id)) return `${where} is missing a valid id`;
  if (e.kind !== "expense" && e.kind !== "income" && e.kind !== "adjust") {
    return `${where} has unknown kind "${String(e.kind)}" — expected expense, income, or adjust`;
  }
  if (!isNonEmptyString(e.account)) return `${where} is missing a valid account`;
  if (typeof e.date !== "string" || !isDateOnly(e.date)) {
    return `${where} is missing a valid date (YYYY-MM-DD)`;
  }
  if (e.note !== undefined && typeof e.note !== "string") {
    return `${where} has a non-string note`;
  }
  if (e.createdAt !== undefined && typeof e.createdAt !== "string") {
    return `${where} has a non-string createdAt`;
  }
  if (e.kind === "adjust") {
    if (!isFiniteNumber(e.balance) || e.balance < 0) {
      return `${where} (adjust) is missing a valid balance (0 or more)`;
    }
  } else {
    if (!isFiniteNumber(e.amount) || e.amount <= 0) {
      return `${where} is missing a valid amount (more than 0)`;
    }
    if (!isNonEmptyString(e.payee)) return `${where} is missing a valid payee`;
  }
  return null;
}

/**
 * Strictly validate a decoded inbox.json value. Any malformed file or any
 * single bad entry fails the whole parse — the caller must surface the
 * error, never skip entries.
 */
export function parseInboxFile(json: unknown): InboxParseResult {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return fail("inbox file isn't a JSON object");
  }
  const doc = json as Record<string, unknown>;
  if (!Array.isArray(doc.entries)) {
    return fail('inbox file is missing the "entries" array');
  }
  for (let i = 0; i < doc.entries.length; i++) {
    const problem = checkEntry(doc.entries[i], i);
    if (problem !== null) return fail(problem);
  }
  return { ok: true, entries: doc.entries as InboxEntry[] };
}

/**
 * Decode a GitHub contents-API response: base64 `.content` -> JSON ->
 * strict inbox parse. Pure; the fetch wrapper below supplies the JSON.
 */
export function decodeInboxPayload(apiJson: unknown): InboxParseResult {
  if (typeof apiJson !== "object" || apiJson === null) {
    return fail("GitHub returned an unexpected response");
  }
  const payload = apiJson as Record<string, unknown>;
  if (typeof payload.content !== "string") {
    return fail("GitHub response has no file content");
  }
  let text: string;
  try {
    text = atob(payload.content.replace(/\s/g, ""));
  } catch {
    return fail("inbox file content isn't valid base64");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail("inbox.json isn't valid JSON");
  }
  return parseInboxFile(json);
}

type FetchImpl = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

/**
 * GET-only fetch of the private inbox file. Distinct error kinds let the
 * UI tell "token expired" (auth) apart from "offline" (network) and
 * "GitHub is broken" (http) — a failed fetch never looks like an empty
 * inbox.
 */
export async function fetchInbox(
  token: string,
  fetchImpl: FetchImpl = globalThis.fetch as unknown as FetchImpl,
): Promise<InboxFetchResult> {
  let res: { status: number; json: () => Promise<unknown> };
  try {
    res = await fetchImpl(INBOX_API_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
      },
    });
  } catch {
    return {
      ok: false,
      error: {
        kind: "network",
        message: "Couldn't reach GitHub — check your connection and try again.",
      },
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      error: {
        kind: "auth",
        message: "GitHub rejected the inbox token — it may have expired.",
      },
    };
  }
  if (res.status < 200 || res.status >= 300) {
    return {
      ok: false,
      error: {
        kind: "http",
        message: `GitHub returned an error (HTTP ${res.status}). Try again in a bit.`,
      },
    };
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return {
      ok: false,
      error: { kind: "malformed", message: "GitHub returned an unreadable response." },
    };
  }
  const parsed = decodeInboxPayload(payload);
  if (!parsed.ok) {
    return { ok: false, error: { kind: "malformed", message: parsed.error } };
  }
  return { ok: true, entries: parsed.entries };
}

/**
 * An inbox "adjust" entry becomes the same AdjustIntent a ?adjust= link
 * produces — the approval flow (DeepLinkAdjust) is shared, never
 * duplicated. Call only with kind === "adjust" entries that passed
 * parseInboxFile (balance is present).
 */
export function inboxAdjustToIntent(entry: InboxEntry): AdjustIntent {
  const balance = entry.balance ?? 0;
  return {
    kind: "adjust",
    accountName: entry.account,
    balanceText: String(Math.round(balance * 1e9) / 1e9),
  };
}

/**
 * Effective date for age checks: when the entry landed in the inbox
 * (createdAt), falling back to the transaction date. A backdated entry
 * submitted today is "new" — its inbox age is what matters for the
 * 60-day stale warning and the 90-day retention.
 */
export function inboxEntryAgeDate(entry: InboxEntry): DateOnly | null {
  if (entry.createdAt) {
    const d = entry.createdAt.slice(0, 10);
    if (isDateOnly(d)) return d;
  }
  if (isDateOnly(entry.date)) return entry.date;
  return null;
}

function daysBetween(from: DateOnly, to: DateOnly): number {
  const ms = Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z");
  return Math.round(ms / 86_400_000);
}

/**
 * Not-yet-applied entries whose effective date is more than 60 days
 * before today. Pure; the caller decides how to warn.
 */
export function staleInboxEntries(
  entries: readonly InboxEntry[],
  appliedIds: readonly string[],
  today: DateOnly,
): InboxEntry[] {
  const applied = new Set(appliedIds);
  return entries.filter((e) => {
    if (applied.has(e.id)) return false;
    const d = inboxEntryAgeDate(e);
    if (d === null) return false;
    return daysBetween(d, today) > 60;
  });
}

export type InboxTokenStatus = "missing" | "ok" | "expiring" | "expired";

/** Days from today until expiry (negative when past). Null when no expiry set. */
export function daysUntilTokenExpiry(expiry: DateOnly | null, today: DateOnly): number | null {
  if (expiry === null) return null;
  return daysBetween(today, expiry);
}

/**
 * Token lifecycle for the UI: missing (inbox hidden), expired
 * (hard banner), expiring within 14 days (soft banner), ok.
 */
export function inboxTokenStatus(
  token: string | null,
  expiry: DateOnly | null,
  today: DateOnly,
): InboxTokenStatus {
  if (!token || token.trim() === "") return "missing";
  const days = daysUntilTokenExpiry(expiry, today);
  if (days === null) return "ok";
  if (days < 0) return "expired";
  if (days <= 14) return "expiring";
  return "ok";
}

// Token storage: localStorage, never IndexedDB, so the token can never
// leak into a JSON backup export. On-device only either way.

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable; the token just won't persist
  }
}

function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function getInboxToken(): string | null {
  const t = safeGet(TOKEN_KEY);
  return t && t.trim() !== "" ? t.trim() : null;
}

export function setInboxToken(token: string): void {
  if (token.trim() === "") safeRemove(TOKEN_KEY);
  else safeSet(TOKEN_KEY, token.trim());
}

export function getInboxTokenExpiry(): DateOnly | null {
  const raw = safeGet(TOKEN_EXPIRY_KEY);
  return raw && isDateOnly(raw) ? raw : null;
}

/**
 * Validate the Settings save: a token without an expiry date can't warn
 * before it dies, so saving a token requires its expiry date (GitHub
 * shows it when the token is created). Clearing the token is always
 * fine. Returns the error message, or null when the save is valid.
 */
export function validateInboxTokenSave(token: string, expiryRaw: string): string | null {
  if (token.trim() === "") return null;
  const expiry = expiryRaw.trim();
  if (expiry === "") {
    return "Add the token's expiry date — GitHub shows it when you create the token.";
  }
  if (!isDateOnly(expiry)) {
    return "Expiry date isn't valid — use YYYY-MM-DD.";
  }
  return null;
}

export function setInboxTokenExpiry(expiry: DateOnly | null): void {
  if (expiry === null) safeRemove(TOKEN_EXPIRY_KEY);
  else safeSet(TOKEN_EXPIRY_KEY, expiry);
}

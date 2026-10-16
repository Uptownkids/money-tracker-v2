/**
 * Self-transfer detection for bank imports (Phase B).
 *
 * Malike moves money between his own accounts two ways; both are
 * Transfers, never income or expense:
 *  1. Wells Fargo online transfers, e.g.
 *     "ONLINE TRANSFER FROM SIDIBE M WAY2SAVE SAVINGS"
 *     "ONLINE TRANSFER TO SIDIBE M WAY2SAVE SAVINGS"
 *     ("TO" = money leaving this account; "FROM" = money coming in.)
 *  2. Zelle, e.g. "ZELLE FROM MALIKE SIDIBE ON 10/15/2026 REF # 123456"
 *
 * The bank writes his name as "SIDIBE M" (online transfers) and
 * "MALIKE SIDIBE" (Zelle). Extra variations live in settings
 * (selfNameVariations) for him to extend.
 */
import { normalizeDescription } from "./fingerprints.js";

/** transferToAccountId value for money sent to an account outside the app. */
export const EXTERNAL_ACCOUNT_ID = "external";

const ONLINE_TRANSFER_RE = /^ONLINE TRANSFER (FROM|TO) (.+)$/;
const ZELLE_RE = /^ZELLE (FROM|TO) (.+)$/;

export interface SelfTransferSignal {
  /** Which of Malike's movement styles this is. */
  kind: "online-transfer" | "zelle";
  /** "TO" = money leaving the parsed account; "FROM" = money coming in. */
  direction: "TO" | "FROM";
  /** The other party as named by the bank, e.g. "SIDIBE M WAY2SAVE SAVINGS". */
  counterparty: string;
}

/** Parse the description; null when it is not a transfer-style line. */
export function detectTransferSignal(description: string): SelfTransferSignal | null {
  const norm = normalizeDescription(description);
  let m = ONLINE_TRANSFER_RE.exec(norm);
  if (m?.[1] && m?.[2]) {
    return { kind: "online-transfer", direction: m[1] as "TO" | "FROM", counterparty: m[2] };
  }
  m = ZELLE_RE.exec(norm);
  if (m?.[1] && m?.[2]) {
    return { kind: "zelle", direction: m[1] as "TO" | "FROM", counterparty: m[2] };
  }
  return null;
}

/** Default self-name variations, exactly as the bank writes them. */
export const DEFAULT_SELF_NAME_VARIATIONS = ["SIDIBE M", "MALIKE SIDIBE"];

/**
 * True when the counterparty names Malike himself. The counterparty may
 * carry an account suffix ("SIDIBE M WAY2SAVE SAVINGS"), so this is a
 * prefix match against each known variation.
 */
export function isSelfCounterparty(counterparty: string, selfNameVariations: readonly string[]): boolean {
  const upper = counterparty.toUpperCase().trim();
  return selfNameVariations.some((v) => {
    const uv = v.toUpperCase().trim();
    return upper === uv || upper.startsWith(uv + " ");
  });
}

/**
 * For online transfers the counterparty names the other account
 * ("SIDIBE M WAY2SAVE SAVINGS" -> "WAY2SAVE SAVINGS"). Strip the leading
 * self-name to get the bank's account label, so it can be mapped to an
 * app account (transferAccountNameMaps in settings).
 */
export function otherAccountLabel(
  signal: SelfTransferSignal,
  selfNameVariations: readonly string[],
): string | null {
  if (signal.kind !== "online-transfer") return null;
  const upper = signal.counterparty.toUpperCase().trim();
  for (const v of selfNameVariations) {
    const uv = v.toUpperCase().trim();
    if (upper === uv) return null;
    if (upper.startsWith(uv + " ")) return upper.slice(uv.length + 1).trim();
  }
  return null;
}

/**
 * Pure fetch-routing logic for the service worker.
 *
 * The service worker (public/sw.js) cannot import TypeScript, so it carries
 * a plain-JS copy of the same rules. The copies are intentionally
 * duplicated: the unit tests in test/swRouting.test.ts exercise THIS module.
 * If you change the rules here, mirror the change in public/sw.js.
 */

export type SwFetchStrategy =
  | "network-first"
  | "cache-first"
  | "stale-while-revalidate"
  | "passthrough";

/**
 * Vite emits content-hashed filenames like assets/index-DiwpuRxA.js or
 * assets/index-DiwpuRxA.css. Only these immutable files are safe to serve
 * cache-first: any content change produces a new filename.
 */
export function isHashedAsset(url: string): boolean {
  return /[-.][0-9A-Za-z]{8}\.(js|css)$/.test(stripQueryAndHash(url));
}

/**
 * Navigations and the app shell must always try the network first so an
 * installed client picks up new builds; the cache is only the offline
 * fallback. The trailing-slash case covers the shell root when the app is
 * hosted under a subpath (base is "./").
 */
export function shouldNetworkFirst(mode: string, url: string): boolean {
  if (mode === "navigate") return true;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  return pathname === "/" || pathname.endsWith("/") || pathname.endsWith("/index.html");
}

export interface SwRouteInput {
  method: string;
  url: string;
  mode: string;
}

/**
 * Decide the cache strategy for one fetch event. `origin` is the service
 * worker's own origin (self.location.origin). Cross-origin requests and
 * non-GET requests pass through untouched.
 */
export function getSwStrategy(input: SwRouteInput, origin: string): SwFetchStrategy {
  if (input.method !== "GET") return "passthrough";
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return "passthrough";
  }
  if (parsed.origin !== origin) return "passthrough";
  if (shouldNetworkFirst(input.mode, input.url)) return "network-first";
  if (isHashedAsset(input.url)) return "cache-first";
  return "stale-while-revalidate";
}

function stripQueryAndHash(url: string): string {
  const query = url.indexOf("?");
  const hash = url.indexOf("#");
  const cuts = [query, hash].filter((i) => i >= 0);
  return cuts.length === 0 ? url : url.slice(0, Math.min(...cuts));
}

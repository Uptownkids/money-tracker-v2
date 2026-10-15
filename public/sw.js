/**
 * Money Tracker service worker — BUILD TEMPLATE.
 *
 * __BUILD_ID__ is stamped at build time by the sw-build-id plugin in
 * vite.config.ts (closeBundle hook): it hashes dist/index.html (sha256,
 * first 12 hex chars) and replaces the placeholder in dist/sw.js. Every
 * build therefore gets a unique CACHE_NAME, so installed phones always
 * pick up new builds. Vite copies public/ to dist/ before closeBundle, so
 * edit THIS template — never dist/sw.js directly.
 *
 * Strategy:
 * - network-first: navigations and index.html (fresh builds win; the cache
 *   is only the offline fallback)
 * - cache-first: content-hashed assets only (Vite emits assets/index-[hash].js)
 * - stale-while-revalidate: other same-origin GETs (manifest, icons)
 * - passthrough: non-GET and cross-origin requests are never intercepted
 *
 * Install does NOT call skipWaiting(): a waiting worker activates only after
 * the user taps Reload in the in-app "New version available" banner, which
 * posts { type: "SKIP_WAITING" } (see src/app/swUpdates.ts).
 *
 * The routing helpers below are plain-JS copies of src/app/swRouting.ts
 * (the service worker cannot import TypeScript). They are unit-tested via
 * test/swRouting.test.ts — if you change the rules, update both files.
 */

const CACHE_NAME = "money-tracker-__BUILD_ID__";
const APP_SHELL = ["./", "./index.html"];

// --- routing helpers (mirror of src/app/swRouting.ts) ---

function swStripQueryAndHash(url) {
  const query = url.indexOf("?");
  const hash = url.indexOf("#");
  const cuts = [query, hash].filter((i) => i >= 0);
  return cuts.length === 0 ? url : url.slice(0, Math.min(...cuts));
}

function isHashedAsset(url) {
  return /[-.][0-9A-Za-z]{8}\.(js|css)$/.test(swStripQueryAndHash(url));
}

function shouldNetworkFirst(mode, url) {
  if (mode === "navigate") return true;
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch (err) {
    return false;
  }
  return pathname === "/" || pathname.endsWith("/") || pathname.endsWith("/index.html");
}

function getSwStrategy(input, origin) {
  if (input.method !== "GET") return "passthrough";
  let parsed;
  try {
    parsed = new URL(input.url);
  } catch (err) {
    return "passthrough";
  }
  if (parsed.origin !== origin) return "passthrough";
  if (shouldNetworkFirst(input.mode, input.url)) return "network-first";
  if (isHashedAsset(input.url)) return "cache-first";
  return "stale-while-revalidate";
}

// --- lifecycle ---

self.addEventListener("install", (event) => {
  // No skipWaiting(): updates are user-confirmed via the in-app banner.
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith("money-tracker-") && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// --- fetch ---

function cachePut(request, response) {
  if (response && response.ok) {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const strategy = getSwStrategy(
    { method: request.method, url: request.url, mode: request.mode },
    self.location.origin,
  );
  if (strategy === "passthrough") return;

  if (strategy === "network-first") {
    event.respondWith(
      fetch(request)
        .then((response) => cachePut(request, response))
        .catch(() =>
          // Offline: fall back to the cached request, then the app shell.
          caches
            .match(request, { ignoreSearch: true })
            .then((cached) => cached || caches.match("./index.html")),
        ),
    );
    return;
  }

  if (strategy === "cache-first") {
    event.respondWith(
      caches
        .match(request, { ignoreSearch: true })
        .then(
          (cached) => cached || fetch(request).then((response) => cachePut(request, response)),
        ),
    );
    return;
  }

  // stale-while-revalidate: serve the cache now, refresh it in the background.
  const cachedPromise = caches.match(request, { ignoreSearch: true });
  const networkPromise = fetch(request).then((response) => cachePut(request, response));
  event.waitUntil(networkPromise.catch(() => undefined));
  event.respondWith(cachedPromise.then((cached) => cached || networkPromise));
});

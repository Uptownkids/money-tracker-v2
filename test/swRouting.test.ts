/**
 * Tests for src/app/swRouting.ts — the pure fetch-routing rules used by the
 * service worker. public/sw.js carries a plain-JS copy of the same rules
 * (the SW cannot import TypeScript); keep both in sync.
 */
import { describe, expect, it } from "vitest";
import { getSwStrategy, isHashedAsset, shouldNetworkFirst } from "../src/app/swRouting.js";

const ORIGIN = "http://localhost:8000";

describe("isHashedAsset", () => {
  it("matches Vite's hashed js/css filenames", () => {
    expect(isHashedAsset(`${ORIGIN}/assets/index-DiwpuRxA.js`)).toBe(true);
    expect(isHashedAsset(`${ORIGIN}/assets/index-DiwpuRxA.css`)).toBe(true);
    expect(isHashedAsset(`${ORIGIN}/assets/vendor.9f8e7d6c.js`)).toBe(true);
  });

  it("ignores query strings and fragments when matching", () => {
    expect(isHashedAsset(`${ORIGIN}/assets/index-DiwpuRxA.js?v=1`)).toBe(true);
    expect(isHashedAsset(`${ORIGIN}/assets/index-DiwpuRxA.css#x`)).toBe(true);
  });

  it("rejects unhashed and non-js/css files", () => {
    expect(isHashedAsset(`${ORIGIN}/assets/index.js`)).toBe(false);
    expect(isHashedAsset(`${ORIGIN}/index.html`)).toBe(false);
    expect(isHashedAsset(`${ORIGIN}/manifest.json`)).toBe(false);
    expect(isHashedAsset(`${ORIGIN}/icons/icon-192.png`)).toBe(false);
    expect(isHashedAsset(`${ORIGIN}/assets/index-DiwpuRxA.js.map`)).toBe(false);
    expect(isHashedAsset(`${ORIGIN}/assets/short-abc.js`)).toBe(false);
  });
});

describe("shouldNetworkFirst", () => {
  it("is true for navigations regardless of url", () => {
    expect(shouldNetworkFirst("navigate", `${ORIGIN}/assets/index-DiwpuRxA.js`)).toBe(true);
    expect(shouldNetworkFirst("navigate", `${ORIGIN}/`)).toBe(true);
  });

  it("is true for the app shell paths", () => {
    expect(shouldNetworkFirst("cors", `${ORIGIN}/`)).toBe(true);
    expect(shouldNetworkFirst("cors", `${ORIGIN}/index.html`)).toBe(true);
    expect(shouldNetworkFirst("cors", `${ORIGIN}/subpath/index.html`)).toBe(true);
    expect(shouldNetworkFirst("cors", `${ORIGIN}/subpath/`)).toBe(true);
  });

  it("is false for assets, manifest and icons", () => {
    expect(shouldNetworkFirst("cors", `${ORIGIN}/assets/index-DiwpuRxA.js`)).toBe(false);
    expect(shouldNetworkFirst("cors", `${ORIGIN}/manifest.json`)).toBe(false);
    expect(shouldNetworkFirst("cors", `${ORIGIN}/icons/icon-192.png`)).toBe(false);
  });

  it("is false for unparseable urls", () => {
    expect(shouldNetworkFirst("cors", "not a url")).toBe(false);
  });
});

describe("getSwStrategy", () => {
  it("passes through non-GET requests", () => {
    expect(getSwStrategy({ method: "POST", url: `${ORIGIN}/`, mode: "cors" }, ORIGIN)).toBe(
      "passthrough",
    );
    expect(getSwStrategy({ method: "PUT", url: `${ORIGIN}/`, mode: "cors" }, ORIGIN)).toBe(
      "passthrough",
    );
  });

  it("passes through cross-origin requests", () => {
    expect(
      getSwStrategy({ method: "GET", url: "https://cdn.example.com/lib.js", mode: "cors" }, ORIGIN),
    ).toBe("passthrough");
  });

  it("passes through unparseable urls", () => {
    expect(getSwStrategy({ method: "GET", url: "::::", mode: "cors" }, ORIGIN)).toBe("passthrough");
  });

  it("uses network-first for navigations and the app shell", () => {
    expect(
      getSwStrategy({ method: "GET", url: `${ORIGIN}/`, mode: "navigate" }, ORIGIN),
    ).toBe("network-first");
    expect(getSwStrategy({ method: "GET", url: `${ORIGIN}/index.html`, mode: "cors" }, ORIGIN)).toBe(
      "network-first",
    );
    expect(
      getSwStrategy({ method: "GET", url: `${ORIGIN}/assets/index-DiwpuRxA.js`, mode: "navigate" }, ORIGIN),
    ).toBe("network-first");
  });

  it("uses cache-first only for hashed assets", () => {
    expect(
      getSwStrategy({ method: "GET", url: `${ORIGIN}/assets/index-DiwpuRxA.js`, mode: "cors" }, ORIGIN),
    ).toBe("cache-first");
    expect(
      getSwStrategy({ method: "GET", url: `${ORIGIN}/assets/index-DiwpuRxA.css`, mode: "cors" }, ORIGIN),
    ).toBe("cache-first");
  });

  it("uses stale-while-revalidate for manifest, icons and other same-origin GETs", () => {
    expect(
      getSwStrategy({ method: "GET", url: `${ORIGIN}/manifest.json`, mode: "cors" }, ORIGIN),
    ).toBe("stale-while-revalidate");
    expect(
      getSwStrategy({ method: "GET", url: `${ORIGIN}/icons/icon-192.png`, mode: "cors" }, ORIGIN),
    ).toBe("stale-while-revalidate");
    expect(
      getSwStrategy({ method: "GET", url: `${ORIGIN}/apple-touch-icon.png`, mode: "cors" }, ORIGIN),
    ).toBe("stale-while-revalidate");
  });
});

/**
 * Persistent-storage request tests. The functions must never throw:
 * unsupported browsers and non-browser environments report false.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isStoragePersisted, requestPersistentStorage } from "../src/app/persistentStorage.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestPersistentStorage", () => {
  it("returns false when navigator is undefined", async () => {
    vi.stubGlobal("navigator", undefined);
    await expect(requestPersistentStorage()).resolves.toBe(false);
  });

  it("returns true when the browser grants persistence", async () => {
    vi.stubGlobal("navigator", { storage: { persist: async () => true } });
    await expect(requestPersistentStorage()).resolves.toBe(true);
  });

  it("returns false when the browser denies persistence", async () => {
    vi.stubGlobal("navigator", { storage: { persist: async () => false } });
    await expect(requestPersistentStorage()).resolves.toBe(false);
  });

  it("returns false when persist throws", async () => {
    vi.stubGlobal("navigator", {
      storage: {
        persist: async () => {
          throw new Error("denied");
        },
      },
    });
    await expect(requestPersistentStorage()).resolves.toBe(false);
  });

  it("returns false when storage.persist is missing", async () => {
    vi.stubGlobal("navigator", { storage: {} });
    await expect(requestPersistentStorage()).resolves.toBe(false);
  });

  it("returns false when navigator.storage is missing", async () => {
    vi.stubGlobal("navigator", {});
    await expect(requestPersistentStorage()).resolves.toBe(false);
  });
});

describe("isStoragePersisted", () => {
  it("returns false when navigator is undefined", async () => {
    vi.stubGlobal("navigator", undefined);
    await expect(isStoragePersisted()).resolves.toBe(false);
  });

  it("mirrors the browser's persisted state", async () => {
    vi.stubGlobal("navigator", { storage: { persisted: async () => true } });
    await expect(isStoragePersisted()).resolves.toBe(true);
    vi.stubGlobal("navigator", { storage: { persisted: async () => false } });
    await expect(isStoragePersisted()).resolves.toBe(false);
  });

  it("returns false when persisted throws or is missing", async () => {
    vi.stubGlobal("navigator", {
      storage: {
        persisted: async () => {
          throw new Error("nope");
        },
      },
    });
    await expect(isStoragePersisted()).resolves.toBe(false);
    vi.stubGlobal("navigator", { storage: {} });
    await expect(isStoragePersisted()).resolves.toBe(false);
  });
});

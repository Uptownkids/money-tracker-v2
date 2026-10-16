/**
 * Persistent storage: ask the browser not to evict this origin's
 * IndexedDB when the device runs low on space. Requested once on app
 * start; Settings shows whether the browser granted it.
 *
 * Both functions never throw: on unsupported browsers, in non-browser
 * environments (tests, SSR), or when the browser denies the request,
 * they simply report false.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined") return false;
    const storage = navigator.storage;
    if (!storage || typeof storage.persist !== "function") return false;
    return await storage.persist();
  } catch {
    return false;
  }
}

/** Current persisted state, for display in Settings. Never throws. */
export async function isStoragePersisted(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined") return false;
    const storage = navigator.storage;
    if (!storage || typeof storage.persisted !== "function") return false;
    return await storage.persisted();
  } catch {
    return false;
  }
}

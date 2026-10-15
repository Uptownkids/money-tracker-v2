/**
 * Service worker update plumbing for the Money Tracker PWA.
 *
 * - initSwUpdates() registers ./sw.js (production only) and detects when a
 *   new worker is waiting to activate.
 * - The "New version available" banner in App subscribes via onSwUpdate();
 *   the banner's Reload button calls applySwUpdate().
 * - Best-effort throughout: nothing here ever throws, even where service
 *   workers are unsupported.
 */

export type SwUpdateListener = () => void;

const listeners = new Set<SwUpdateListener>();
let updateWaiting = false;

/**
 * Subscribe to "a new version is waiting" events. Returns an unsubscribe
 * function. If an update is already waiting when you subscribe (it arrived
 * before React mounted), the listener fires immediately so it is never
 * missed.
 */
export function onSwUpdate(listener: SwUpdateListener): () => void {
  listeners.add(listener);
  if (updateWaiting) {
    try {
      listener();
    } catch {
      // A failing listener must never break the update flow.
    }
  }
  return () => {
    listeners.delete(listener);
  };
}

/** True once a waiting worker has been detected (survives until reload). */
export function isSwUpdateWaiting(): boolean {
  return updateWaiting;
}

function emitSwUpdate(): void {
  updateWaiting = true;
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch {
      // A failing listener must never break the update flow.
    }
  }
}

/**
 * Register ./sw.js in production and watch for updates. Calls onUpdate()
 * (and notifies onSwUpdate subscribers) when a new worker reaches
 * "installed" while a previous worker still controls the page, or when a
 * worker is already waiting at registration time.
 */
export function initSwUpdates(onUpdate: () => void): void {
  const handleUpdate = () => {
    emitSwUpdate();
    try {
      onUpdate();
    } catch {
      // Same guarantee for the explicit callback.
    }
  };

  try {
    if (!import.meta.env.PROD) return;
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker
      .register("./sw.js")
      .then((registration) => {
        // A worker may already be waiting (installed on a previous visit).
        if (registration.waiting) {
          handleUpdate();
          return;
        }
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            // "installed" with an active controller means a NEW worker is
            // waiting; the first install has no controller yet.
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              handleUpdate();
            }
          });
        });
      })
      .catch(() => {
        // Ignore registration failures (file://, unsupported browser, ...).
      });
  } catch {
    // Service workers unsupported or otherwise unavailable: stay silent.
  }
}

/**
 * Activate the waiting worker, then reload once it takes control so the
 * new build actually loads.
 */
export function applySwUpdate(): void {
  const reload = () => {
    try {
      window.location.reload();
    } catch {
      // Ignore: there is nothing left to try.
    }
  };
  try {
    if (!("serviceWorker" in navigator)) {
      reload();
      return;
    }
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      reload();
    });
    void navigator.serviceWorker
      .getRegistration()
      .then((registration) => {
        const waiting = registration?.waiting;
        if (waiting) {
          waiting.postMessage({ type: "SKIP_WAITING" });
        } else {
          // No waiting worker: a plain reload still picks up whatever the
          // server now serves.
          reload();
        }
      })
      .catch(() => {
        reload();
      });
  } catch {
    reload();
  }
}

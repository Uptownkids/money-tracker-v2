import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { initSwUpdates } from "./swUpdates.js";

const root = document.getElementById("root");
if (!root) throw new Error("money-tracker: #root element missing");

// Installable PWA: register the service worker in production only (see
// swUpdates.ts). Relative path so it works under any subpath. Updates are
// user-confirmed: the "New version available" banner in App subscribes to
// update events via onSwUpdate(), so no startup-time callback is needed
// here beyond registration.
initSwUpdates(() => {
  // Intentionally empty: App owns the update UI and subscribes itself.
});

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

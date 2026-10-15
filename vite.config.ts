import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Stamp a content-hash build id into dist/sw.js so every build gets a
 * unique service worker cache name ("money-tracker-<12 hex chars>"). Runs
 * on every `vite build` (including a bare `npx vite build`): Vite copies
 * public/ to dist/ before closeBundle, so dist/sw.js already exists here.
 * The id is the sha256 of the built index.html — any shell change produces
 * a new id, and identical builds reuse the same cache.
 */
function swBuildIdPlugin(): Plugin {
  return {
    name: "money-tracker-sw-build-id",
    closeBundle() {
      const distDir = join(process.cwd(), "dist");
      const html = readFileSync(join(distDir, "index.html"), "utf8");
      const buildId = createHash("sha256").update(html).digest("hex").slice(0, 12);
      const swPath = join(distDir, "sw.js");
      const sw = readFileSync(swPath, "utf8");
      if (!sw.includes("__BUILD_ID__")) {
        throw new Error("money-tracker: dist/sw.js is missing the __BUILD_ID__ placeholder");
      }
      writeFileSync(swPath, sw.replaceAll("__BUILD_ID__", buildId));
    },
  };
}

export default defineConfig({
  // Relative asset paths so the built app works when hosted under any subpath.
  base: "./",
  plugins: [react(), tailwindcss(), swBuildIdPlugin()],
});

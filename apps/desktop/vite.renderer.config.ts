import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  resolve: {
    // The desktop workspace and hoisted Radix dependencies must share the same
    // React dispatcher. Rolldown otherwise optimizes nested peer paths as a
    // second React instance and every hook call fails at runtime.
    dedupe: ["react", "react-dom"],
  },
  // The renderer consumes locally built workspace packages. A previous dev run's
  // optimized copy can otherwise survive a protocol/projector version bump and
  // reject an otherwise valid Runtime Host snapshot.
  optimizeDeps: {
    force: true,
  },
  build: {
    outDir: resolve(import.meta.dirname, ".vite/renderer/main_window"),
    sourcemap: false,
  },
});

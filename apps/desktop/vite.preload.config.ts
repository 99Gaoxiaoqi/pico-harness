import { defineConfig } from "vite";
import { nodeSqliteExternal } from "./vite.node-externals.js";

export default defineConfig({
  build: {
    sourcemap: false,
    rollupOptions: {
      external: ["electron", nodeSqliteExternal],
      output: { entryFileNames: "preload.cjs", format: "cjs" },
    },
  },
});

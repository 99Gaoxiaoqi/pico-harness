import { defineConfig } from "vite";
import { nodeBuiltinExternal } from "./vite.node-externals.js";

export default defineConfig({
  build: {
    sourcemap: false,
    rollupOptions: {
      external: ["electron", nodeBuiltinExternal],
      output: { entryFileNames: "preload.cjs", format: "cjs" },
    },
  },
});

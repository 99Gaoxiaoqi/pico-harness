import { defineConfig } from "vite";

export default defineConfig({
  build: {
    sourcemap: false,
    rollupOptions: {
      external: ["electron"],
      output: { entryFileNames: "preload.cjs", format: "cjs" },
    },
  },
});

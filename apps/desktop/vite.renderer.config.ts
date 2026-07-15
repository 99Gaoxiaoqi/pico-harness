import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, ".vite/renderer/main_window"),
    sourcemap: false,
  },
});

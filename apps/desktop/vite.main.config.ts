import { defineConfig } from "vite";

export default defineConfig({
  build: {
    sourcemap: true,
    rollupOptions: {
      external: ["electron", "better-sqlite3", "node-pty"],
      output: { entryFileNames: "main.js" },
    },
  },
});

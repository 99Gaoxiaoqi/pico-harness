import { defineConfig } from "vite";

const updateFeedUrl = readOptionalHttpsUrl("PICO_UPDATE_FEED_URL");

export default defineConfig({
  define: {
    __PICO_UPDATE_FEED_URL__: JSON.stringify(updateFeedUrl ?? null),
  },
  build: {
    sourcemap: false,
    rollupOptions: {
      external: ["electron", "better-sqlite3"],
      output: {
        entryFileNames: "main.cjs",
        format: "cjs",
        // The Desktop process needs Electron's ABI without mutating the
        // Node/TUI package installed at the workspace root.
        paths: { "better-sqlite3": "better-sqlite3-electron" },
      },
    },
  },
});

function readOptionalHttpsUrl(name: string): string | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("must use HTTPS");
    return url.toString();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${name} must be a valid HTTPS URL: ${reason}`, { cause: error });
  }
}

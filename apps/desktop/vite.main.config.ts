import { defineConfig } from "vite";

const updateFeedUrl = readOptionalHttpsUrl("PICO_UPDATE_FEED_URL");
const bundledModuleUrlGlobal = "__PICO_MAIN_IMPORT_META_URL__";

export default defineConfig({
  define: {
    __PICO_UPDATE_FEED_URL__: JSON.stringify(updateFeedUrl ?? null),
    // Shared ESM modules use createRequire(import.meta.url) during startup.
    // Keep a real file URL after bundling the main process as CommonJS.
    "import.meta.url": `globalThis.${bundledModuleUrlGlobal}`,
  },
  build: {
    sourcemap: false,
    rollupOptions: {
      // Keep the native addon package boundary intact. Bundling it rewrites the
      // package-relative `require.addon(".")` lookup to the Vite output folder.
      external: ["electron", "fs-native-extensions"],
      output: {
        codeSplitting: true,
        banner: `globalThis.${bundledModuleUrlGlobal} = require("node:url").pathToFileURL(__filename).href;`,
        entryFileNames: "main.cjs",
        format: "cjs",
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

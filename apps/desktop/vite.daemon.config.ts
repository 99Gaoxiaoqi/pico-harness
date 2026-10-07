import { defineConfig } from "vite";
import { copyDesktopRuntimeResources } from "./desktop-runtime-resources.js";

const bundledModuleUrlGlobal = "__PICO_DAEMON_IMPORT_META_URL__";

export default defineConfig({
  // The daemon target is emitted as CommonJS so Electron can run it in
  // ELECTRON_RUN_AS_NODE mode. Preserve the file-URL semantics expected by
  // source modules that use import.meta.url for createRequire/asset lookup.
  //
  // Do not inline `require("node:url")` at every import.meta.url call site.
  // A call site such as `const require = createRequire(import.meta.url)` would
  // then read its own lexical `require` before initialization after bundling.
  // Initialize one unshadowable global in the output banner instead.
  define: {
    "import.meta.url": `globalThis.${bundledModuleUrlGlobal}`,
  },
  build: {
    sourcemap: false,
    rollupOptions: {
      // Keep native addon and parser WASM package boundaries intact. Development
      // resolves them from the workspace; packaging copies dependencies beside
      // the daemon bundle during Electron's dependency-copy phase.
      external: ["fs-native-extensions", "node-pty", "web-tree-sitter"],
      output: {
        banner: `globalThis.${bundledModuleUrlGlobal} = require("node:url").pathToFileURL(__filename).href;`,
        entryFileNames: "daemon.cjs",
        format: "cjs",
      },
    },
  },
  plugins: [
    {
      name: "pico:copy-runtime-dependencies",
      closeBundle() {
        copyDesktopRuntimeResources(import.meta.dirname);
      },
    },
  ],
});

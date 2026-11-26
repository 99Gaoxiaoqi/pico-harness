import { defineConfig } from "vite";
import { nodeBuiltinExternal } from "./vite.node-externals.js";
const bundledModuleUrlGlobal = "__PICO_GATEWAY_SUPERVISOR_IMPORT_META_URL__";
export default defineConfig({
  define: { "import.meta.url": `globalThis.${bundledModuleUrlGlobal}` },
  build: {
    sourcemap: false,
    rollupOptions: {
      external: [nodeBuiltinExternal, "fs-native-extensions", "node-pty"],
      output: {
        banner: `globalThis.${bundledModuleUrlGlobal} = require("node:url").pathToFileURL(__filename).href;`,
        entryFileNames: "gateway-supervisor.cjs",
        format: "cjs",
      },
    },
  },
});

import { chmodSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const nativeRuntimePackages = [
  "fs-native-extensions",
  "require-addon",
  "which-runtime",
  "bare-addon-resolve",
  "bare-module-resolve",
  "bare-semver",
  "node-pty",
  "node-addon-api",
] as const;

export default defineConfig({
  // The daemon target is emitted as CommonJS so Electron can run it in
  // ELECTRON_RUN_AS_NODE mode. Preserve the file-URL semantics expected by
  // source modules that use import.meta.url for createRequire/asset lookup.
  define: {
    "import.meta.url": "require('node:url').pathToFileURL(__filename).href",
  },
  build: {
    sourcemap: false,
    rollupOptions: {
      // Keep the native addon package boundary intact. Development resolves it
      // from the workspace; packaging copies production dependencies beside the
      // daemon bundle during Electron's native-dependency phase.
      external: ["fs-native-extensions", "node-pty"],
      output: {
        entryFileNames: "daemon.cjs",
        format: "cjs",
      },
    },
  },
  plugins: [
    {
      name: "pico:copy-runtime-native-dependencies",
      closeBundle() {
        const targetRoot = resolve(import.meta.dirname, ".vite/build/node_modules");
        mkdirSync(targetRoot, { recursive: true });
        for (const packageName of nativeRuntimePackages) {
          const source = resolve(import.meta.dirname, "../../node_modules", packageName);
          const target = resolve(targetRoot, packageName);
          rmSync(target, { recursive: true, force: true });
          cpSync(source, target, { recursive: true, dereference: true });
        }
        if (process.platform !== "win32") {
          for (const helper of [
            resolve(
              targetRoot,
              "node-pty/prebuilds",
              `${process.platform}-${process.arch}`,
              "spawn-helper",
            ),
            resolve(targetRoot, "node-pty/build/Release/spawn-helper"),
          ]) {
            try {
              chmodSync(helper, 0o755);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
        }
      },
    },
  ],
});

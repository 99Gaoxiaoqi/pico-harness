import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "vite";

test("Desktop CommonJS main bundle loads shared ESM dependencies before Electron startup", async (t) => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const scratch = await mkdtemp(join(tmpdir(), "pico-main-bundle-startup-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await build({
    configFile: join(root, "apps/desktop/vite.main.config.ts"),
    logLevel: "silent",
    build: {
      outDir: scratch,
      emptyOutDir: false,
      lib: {
        entry: join(root, "apps/desktop/src/main/index.ts"),
        formats: ["cjs"],
      },
      rollupOptions: {
        external: [
          ...builtinModules,
          ...builtinModules.map((name) => `node:${name}`),
          "electron",
          "fs-native-extensions",
        ],
      },
    },
  });
  const fixture = join(scratch, "load-main.cjs");
  await writeFile(
    fixture,
    `const assert = require("node:assert/strict");
const Module = require("node:module");
const rootRequire = Module.createRequire(${JSON.stringify(join(root, "package.json"))});
const nativeExtensions = rootRequire("fs-native-extensions");
const originalLoad = Module._load;
let quitCalled = false;
Module._load = function(name, ...args) {
  if (name === "electron") return { app: {
    getPath: () => process.env.PICO_HOME,
    requestSingleInstanceLock: () => false,
    quit: () => { quitCalled = true; },
  } };
  if (name === "fs-native-extensions") return nativeExtensions;
  return originalLoad.call(this, name, ...args);
};
require("./main.cjs");
assert.equal(quitCalled, true, "shared imports must load before the single-instance exit");
console.log("PASS: Desktop main bundle reached Electron startup");
`,
  );
  const result = spawnSync(process.execPath, [fixture], {
    env: { ...process.env, PICO_HOME: join(scratch, "pico-home") },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
  assert.match(result.stdout, /PASS: Desktop main bundle reached Electron startup/);
});

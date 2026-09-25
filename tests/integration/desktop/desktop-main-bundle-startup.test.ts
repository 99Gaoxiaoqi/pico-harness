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
setImmediate(() => {
assert.equal(quitCalled, true, "shared imports must load before the single-instance exit");
console.log("PASS: Desktop main bundle reached Electron startup");
});
`,
  );
  const result = spawnSync(process.execPath, [fixture], {
    env: { ...process.env, PICO_HOME: join(scratch, "pico-home") },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
  assert.match(result.stdout, /PASS: Desktop main bundle reached Electron startup/);

  const installerFixture = join(scratch, "installer-event.cjs");
  await writeFile(
    installerFixture,
    `
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const fs = require("node:fs");
const event = process.argv[2];
Object.defineProperty(process, "platform", { value: "win32" });
process.argv = [process.execPath, event];
const updaterPath = path.resolve(path.dirname(process.execPath), "..", "Update.exe");
const realpath = fs.realpathSync.native;
fs.realpathSync.native = (target, ...args) => target === updaterPath ? target : realpath(target, ...args);
let exitCode;
const calls = [];
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === "electron") return { app: {
    quit: () => { exitCode = 0; },
    exit: code => { exitCode = code; },
    getPath: () => { throw new Error("installer callback entered normal startup"); },
  } };
  if (name === "node:child_process") return { spawn: (command, argv, options) => {
    calls.push({command, argv, options});
    const child = new EventEmitter();
    process.nextTick(() => child.emit("close", 0));
    return child;
  } };
  if (name === "fs-native-extensions") throw new Error("installer loaded runtime dependencies");
  return originalLoad.call(this, name, ...args);
};
require("./main.cjs");
setImmediate(() => {
  assert.equal(exitCode, 0);
  if (event === "--squirrel-obsolete") assert.deepEqual(calls, []);
  else assert.deepEqual(calls, [{
    command: path.resolve(path.dirname(process.execPath), "..", "Update.exe"),
    argv: [event === "--squirrel-uninstall" ? "--removeShortcut" : "--createShortcut", path.basename(process.execPath)],
    options: {windowsHide: true},
  }]);
  console.log("PASS: installer callback exited before runtime startup");
});
`,
  );
  for (const event of [
    "--squirrel-install",
    "--squirrel-updated",
    "--squirrel-uninstall",
    "--squirrel-obsolete",
  ]) {
    const installer = spawnSync(process.execPath, [installerFixture, event], {
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(installer.status, 0, `${event}: ${installer.error ?? ""}\n${installer.stderr}`);
    assert.match(installer.stdout, /PASS: installer callback exited before runtime startup/);
  }
});

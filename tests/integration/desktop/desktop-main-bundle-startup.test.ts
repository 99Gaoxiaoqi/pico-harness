import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    env: {
      ...process.env,
      PICO_HOME: join(scratch, "pico-home"),
      // The bundle is relocated to a temporary directory; a packaged app
      // resolves its external CommonJS requires from the installation beside
      // the entry file.
      NODE_PATH: join(root, "node_modules"),
    },
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
const nativeExtensions = Module.createRequire(${JSON.stringify(join(root, "package.json"))})("fs-native-extensions");
const childProcess = require("node:child_process");
const calls = [];
const settle = code => {
  assert.equal(code, 0);
  if (event === "--squirrel-obsolete") assert.deepEqual(calls, []);
  else assert.deepEqual(calls, [{
    command: path.resolve(path.dirname(process.execPath), "..", "Update.exe"),
    argv: [event === "--squirrel-uninstall" ? "--removeShortcut" : "--createShortcut", path.basename(process.execPath)],
    options: {windowsHide: true},
  }]);
  console.log("PASS: installer callback exited before runtime startup");
};
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === "electron") return { app: {
    isPackaged: false,
    getVersion: () => "0.0.0",
    quit: () => settle(0),
    exit: code => settle(code),
    getPath: key => {
      if (key === "userData") return process.env.PICO_HOME;
      throw new Error("installer callback entered normal startup: " + key);
    },
  } };
  if (name === "node:child_process") return {
    ...childProcess,
    spawn: (command, argv, options) => {
      calls.push({command, argv, options});
      const child = new EventEmitter();
      process.nextTick(() => child.emit("close", 0));
      return child;
    },
    // The gateway transition privately protects its state with PowerShell;
    // the installer contract only requires the transition to settle.
    execFile: (_file, _argv, _options, callback) => callback(null, "", ""),
    exec: (_command, _options, callback) => callback(null, "", ""),
    execFileSync: () => Buffer.alloc(0),
  };
  // Installer callbacks run the gateway transition, which is part of the
  // packaged runtime; only normal application startup must stay unloaded.
  if (name === "fs-native-extensions") return nativeExtensions;
  return originalLoad.call(this, name, ...args);
};
require("./main.cjs");
`,
  );
  const installerHome = join(scratch, "installer-home");
  await mkdir(installerHome, { recursive: true });
  await t.test(
    "Desktop installer callbacks exit before runtime startup",
    {
      skip:
        process.platform === "win32"
          ? false
          : "Squirrel installer events and Update.exe only exist on Windows; win32 Desktop CI verifies them",
    },
    () => {
      for (const event of [
        "--squirrel-install",
        "--squirrel-updated",
        "--squirrel-uninstall",
        "--squirrel-obsolete",
      ]) {
        const installer = spawnSync(process.execPath, [installerFixture, event], {
          // The gateway transition keeps its state under the user home.
          env: {
            ...process.env,
            PICO_HOME: installerHome,
            HOME: installerHome,
            USERPROFILE: installerHome,
            NODE_PATH: join(root, "node_modules"),
          },
          encoding: "utf8",
          timeout: 15_000,
        });
        assert.equal(
          installer.status,
          0,
          `${event}: ${installer.error ?? ""}\n${installer.stderr}`,
        );
        assert.match(installer.stdout, /PASS: installer callback exited before runtime startup/);
      }
    },
  );
});

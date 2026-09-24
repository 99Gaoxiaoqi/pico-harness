import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import forgeConfig from "../../../apps/desktop/forge.config.js";
import { resolveSquirrelUpdaterPath } from "../../../apps/desktop/src/main/squirrel-paths.js";

test("Squirrel shortcut creation uses the physical installation path across directory redirection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-shortcut-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const physical = join(root, "physical");
  const alias = join(root, "redirected");
  await mkdir(join(physical, "app-0.1.0"), { recursive: true });
  await writeFile(join(physical, "Update.exe"), "fixture");
  await symlink(physical, alias, process.platform === "win32" ? "junction" : "dir");
  const expected = await realpath(join(physical, "Update.exe"));
  assert.equal(resolveSquirrelUpdaterPath(join(physical, "app-0.1.0", "Pico.exe")), expected);
  assert.equal(
    resolveSquirrelUpdaterPath(join(alias, "app-0.1.0", "Pico.exe")),
    expected,
    "Explorer must not receive the installer's redirected path in shortcuts",
  );
});

test("Windows installer and installed-app entry use the Pico icon rather than framework defaults", async () => {
  const maker = forgeConfig.makers.find((candidate) => candidate instanceof MakerSquirrel);
  assert.ok(maker);
  await maker.prepareConfig("x64");
  const icon = join(import.meta.dirname, "../../../apps/desktop/assets/icon.ico");
  assert.equal(maker.config.setupIcon, icon, "Setup.exe and Update.exe need an explicit Pico icon");
  assert.equal(
    maker.config.iconUrl,
    "https://raw.githubusercontent.com/99Gaoxiaoqi/pico-harness/main/apps/desktop/assets/icon.ico",
    "Squirrel otherwise downloads the Electron icon for the installed-app entry",
  );
  assert.notEqual(maker.config.skipUpdateIcon, true);
  const bytes = await readFile(icon);
  assert.equal(bytes.readUInt16LE(0), 0);
  assert.equal(bytes.readUInt16LE(2), 1, "Windows icon must be ICO, not a renamed PNG");
  assert.ok(bytes.readUInt16LE(4) > 0);
});

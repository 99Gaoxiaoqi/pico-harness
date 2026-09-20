import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ResolvedForgeConfig } from "@electron-forge/shared-types";
import { sandboxPackageHooks } from "../../../apps/desktop/sandbox-package-hooks.js";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import forgeConfig from "../../../apps/desktop/forge.config.js";

test("Windows installer owns a separate directory and uses matching application identity", async () => {
  const maker = forgeConfig.makers.find((candidate) => candidate instanceof MakerSquirrel);
  assert.ok(maker);
  await maker.prepareConfig("x64");
  assert.equal(maker.config.name, "pico_desktop");
  assert.notEqual(maker.config.name.toLowerCase(), "pico", "installer must not own runtime data");
  assert.equal(forgeConfig.packagerConfig.win32metadata.CompanyName, "Pico");
  const main = await readFile(
    new URL("../../../apps/desktop/src/main/application.ts", import.meta.url),
    "utf8",
  );
  assert.ok(main.includes(`app.setAppUserModelId("com.squirrel.${maker.config.name}.Pico")`));
});

test("desktop packaging rejects missing and corrupt Windows sandbox inputs and copied outputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const target = join(root, "Pico-win32-x64");
  const hooks = sandboxPackageHooks(source, root);
  const config = {} as ResolvedForgeConfig;
  await assert.rejects(hooks.prePackage(config, "win32", "x64"), { code: "ENOENT" });
  await mkdir(join(source, "win32-x64"), { recursive: true });
  await writeFile(
    join(source, "manifest.json"),
    JSON.stringify({
      version: 1,
      windows: {
        architectures: ["x64"],
        broker: "pico-appcontainer-broker.exe",
        hostPrep: "pico-appcontainer-host-prep.exe",
      },
    }),
  );
  await assert.rejects(
    hooks.prePackage(config, "win32", "x64"),
    /sandbox resource missing or invalid/,
  );
  for (const name of ["pico-appcontainer-broker.exe", "pico-appcontainer-host-prep.exe"]) {
    const data = Buffer.from(`fixture ${name}`);
    await writeFile(join(source, "win32-x64", name), data);
    await writeFile(
      join(source, "win32-x64", `${name}.sha256`),
      createHash("sha256").update(data).digest("hex"),
    );
  }
  await hooks.prePackage(config, "win32", "x64");
  const result = { platform: "win32" as const, arch: "x64" as const, outputPaths: [target] };
  await assert.rejects(hooks.postPackage(config, result), { code: "ENOENT" });
  await cp(source, join(target, "resources", "sandbox"), { recursive: true });
  await hooks.postPackage(config, result);
  await hooks.preMake();
  await writeFile(
    join(target, "resources", "sandbox", "win32-x64", "pico-appcontainer-broker.exe"),
    "corrupted",
  );
  await assert.rejects(hooks.postPackage(config, result), /sandbox resource missing or invalid/);
  await assert.rejects(hooks.preMake(), /sandbox resource missing or invalid/);
});

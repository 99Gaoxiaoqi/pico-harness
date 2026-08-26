import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

interface DesktopPackageManifest {
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
}

const RUNTIME_HOST_BUILD = "npm run build --workspace @pico/runtime-host";
const DESKTOP_FORGE_RUNNER = "../../scripts/run-desktop-forge.mjs";

test("Desktop cold workflows delegate runtime-host preparation to the Forge runner", async () => {
  const [manifestSource, runnerSource] = await Promise.all([
    readFile(new URL("../../apps/desktop/package.json", import.meta.url), "utf8"),
    readFile(new URL("../../scripts/run-desktop-forge.mjs", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource) as DesktopPackageManifest;

  assert.equal(manifest.dependencies?.["@pico/runtime-host"], "*");
  for (const lifecycle of ["start", "package", "make"] as const) {
    assert.ok(
      manifest.scripts?.[lifecycle]?.includes(DESKTOP_FORGE_RUNNER),
      `${lifecycle} must delegate cold-start preparation to the Desktop Forge runner`,
    );
  }
  assert.ok(
    manifest.scripts?.["pretypecheck"]?.includes(RUNTIME_HOST_BUILD),
    "pretypecheck must rebuild runtime-host before Desktop consumes its authority API",
  );
  assert.ok(
    runnerSource.includes('"@pico/runtime-host"') &&
      runnerSource.includes('["run", "build", "--workspace", workspace]'),
    "the Desktop Forge runner must rebuild runtime-host before start/package/make",
  );
});

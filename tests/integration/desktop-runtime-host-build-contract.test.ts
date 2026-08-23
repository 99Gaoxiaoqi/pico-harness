import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

interface DesktopPackageManifest {
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
}

const RUNTIME_HOST_BUILD = "npm run build --workspace @pico/runtime-host";

test("Desktop cold workflows build their direct runtime-host authority dependency", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../apps/desktop/package.json", import.meta.url), "utf8"),
  ) as DesktopPackageManifest;

  assert.equal(manifest.dependencies?.["@pico/runtime-host"], "*");
  for (const lifecycle of ["prestart", "prepackage", "premake", "pretypecheck"] as const) {
    assert.ok(
      manifest.scripts?.[lifecycle]?.includes(RUNTIME_HOST_BUILD),
      `${lifecycle} must rebuild runtime-host before Desktop consumes its authority API`,
    );
  }
});

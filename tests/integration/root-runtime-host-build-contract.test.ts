import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

interface RootPackageManifest {
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly bundleDependencies?: readonly string[];
}

const RUNTIME_HOST_BUILD = "npm run build:runtime-host";

test("Root CLI cold workflows build and package their runtime-host dependency", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as RootPackageManifest;

  assert.equal(manifest.dependencies?.["@pico/runtime-host"], "*");
  for (const lifecycle of ["predev", "prebuild"] as const) {
    assert.ok(
      manifest.scripts?.[lifecycle]?.includes(RUNTIME_HOST_BUILD),
      `${lifecycle} must rebuild runtime-host before the root CLI consumes its dist export`,
    );
  }
  assert.ok(
    manifest.scripts?.["prepack"]?.includes("npm run build"),
    "prepack must use the cold-safe root build lifecycle",
  );
  assert.ok(
    manifest.bundleDependencies?.includes("@pico/runtime-host"),
    "the packed CLI must include its private runtime-host dependency",
  );
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
// @ts-expect-error The benchmark bundler is intentionally plain Node ESM.
import { createBundlePackagePlan } from "../../../scripts/terminal-bench/build-bundle.mjs";

test("Terminal-Bench approved bundle lock matches runtime dependencies", async () => {
  const lockRaw = await readFile("benchmarks/terminal_bench_2_1/bundle-package-lock.json", "utf8");
  const approvedSha256 = (
    await readFile("benchmarks/terminal_bench_2_1/bundle-lock-sha256.txt", "utf8")
  ).trim();
  assert.equal(createHash("sha256").update(lockRaw).digest("hex"), approvedSha256);

  const lock = JSON.parse(lockRaw);
  assert.equal(lock.lockfileVersion, 3);
  const { packageJson, localPackages } = await createBundlePackagePlan();
  assert.deepEqual(lock.packages[""].dependencies, packageJson.dependencies);
  assert.ok(localPackages.length >= 8, "all eight runtime workspace packages must be bundled");
  for (const local of localPackages) {
    const name = local.packageJson.name;
    assert.equal(packageJson.dependencies[name], `file:${local.path}`);
    assert.equal(lock.packages[`node_modules/${name}`].resolved, local.path);
    assert.equal(lock.packages[`node_modules/${name}`].link, true);
    assert.equal(lock.packages[local.path].version, local.packageJson.version);
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      assert.deepEqual(
        lock.packages[local.path][field],
        local.packageJson[field],
        `${name} ${field}`,
      );
    }
    assert.ok(local.artifacts.includes("dist"));
    assert.equal(local.packageJson.scripts, undefined);
    assert.equal(local.packageJson.devDependencies, undefined);
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path.includes("node_modules/@pico/")) {
      assert.equal(
        (entry as { link?: boolean }).link,
        true,
        `${path} must never resolve via registry`,
      );
    }
  }
});

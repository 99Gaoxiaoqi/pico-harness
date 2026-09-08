import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Terminal-Bench approved bundle lock matches runtime dependencies", async () => {
  const lockRaw = await readFile("benchmarks/terminal_bench_2_1/bundle-package-lock.json", "utf8");
  const approvedSha256 = (
    await readFile("benchmarks/terminal_bench_2_1/bundle-lock-sha256.txt", "utf8")
  ).trim();
  assert.equal(createHash("sha256").update(lockRaw).digest("hex"), approvedSha256);

  const rootPackage = JSON.parse(await readFile("package.json", "utf8"));
  const lock = JSON.parse(lockRaw);
  assert.equal(lock.lockfileVersion, 3);
  const deps = Object.fromEntries(
    Object.entries(rootPackage.dependencies).filter(
      ([name]) => name !== "@pico/runtime-host" && name !== "@pico/transcript-replica",
    ),
  );
  assert.deepEqual(lock.packages[""].dependencies, {
    ...deps,
    "@pico/protocol": "file:packages/protocol",
  });
  assert.equal(lock.packages["node_modules/@pico/protocol"].resolved, "packages/protocol");
});

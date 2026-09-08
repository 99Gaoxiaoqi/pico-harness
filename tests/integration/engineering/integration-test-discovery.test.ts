import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("integration entry discovers nested domains, preserves Windows opt-in, and rejects empty selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-test-discovery-"));
  try {
    await mkdir(join(root, "scripts"));
    for (const domain of ["memory", "desktop/pages", "windows"]) {
      await mkdir(join(root, "tests/integration", domain), { recursive: true });
    }
    const runner = join(root, "scripts/run-integration-tests.mjs");
    await copyFile(new URL("../../../scripts/run-integration-tests.mjs", import.meta.url), runner);
    for (const file of [
      "memory/recall.test.ts",
      "desktop/pages/view.test.tsx",
      "windows/acl.test.ts",
      "memory/helper.ts",
    ]) {
      await writeFile(join(root, "tests/integration", file), "");
    }
    const list = (...args: string[]) =>
      execFileSync(process.execPath, [runner, "--list", ...args], { encoding: "utf8" })
        .trim()
        .split("\n");
    assert.deepEqual(list(), [
      "tests/integration/desktop/pages/view.test.tsx",
      "tests/integration/memory/recall.test.ts",
    ]);
    assert.deepEqual(list("--windows"), ["tests/integration/windows/acl.test.ts"]);
    assert.deepEqual(list("memory/"), ["tests/integration/memory/recall.test.ts"]);
    assert.equal(spawnSync(process.execPath, [runner, "--list", "missing-domain"]).status, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

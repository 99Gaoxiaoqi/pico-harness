import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireBenchmarkLock } from "./benchmark-lock.mjs";

const root = await mkdtemp(join(tmpdir(), "pico-terminal-bench-lock-"));
try {
  const owner = await acquireBenchmarkLock(root);
  const activeWork = join(root, "work", "active-run");
  await mkdir(activeWork, { recursive: true });
  await assert.rejects(
    acquireBenchmarkLock(root),
    /Another Terminal-Bench publication process owns the benchmark lock/u,
  );
  await access(activeWork);
  await owner.release();

  await mkdir(join(root, ".run-lock"));
  await writeFile(
    join(root, ".run-lock", "owner.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      pid: 2_147_483_647,
      token: "stale",
      startedAt: new Date(0).toISOString(),
    })}\n`,
  );
  const recovered = await acquireBenchmarkLock(root);
  await recovered.release();
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stdout.write("Terminal-Bench publication lock boundary passed.\n");

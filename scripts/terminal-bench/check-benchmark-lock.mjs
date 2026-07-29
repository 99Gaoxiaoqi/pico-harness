import assert from "node:assert/strict";
import { access, appendFile, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { acquireBenchmarkLock } from "./benchmark-lock.mjs";

if (process.env.PICO_TB_LOCK_CONTENDER_ROOT) {
  try {
    const lock = await acquireBenchmarkLock(process.env.PICO_TB_LOCK_CONTENDER_ROOT);
    let critical;
    try {
      critical = await open(join(process.env.PICO_TB_LOCK_CONTENDER_ROOT, "critical"), "wx");
      await appendFile(
        join(process.env.PICO_TB_LOCK_CONTENDER_ROOT, "acquired"),
        `${process.pid}\n`,
      );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    } finally {
      await critical?.close();
      await rm(join(process.env.PICO_TB_LOCK_CONTENDER_ROOT, "critical"), { force: true });
      await lock.release();
    }
  } catch (error) {
    if (error?.code === "EEXIST") process.exit(9);
  }
  process.exit(0);
}

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

  await mkdir(join(root, ".run-lock"));
  await writeFile(join(root, ".run-lock", "owner.json"), "{");
  const recoveredCorrupt = await acquireBenchmarkLock(root);
  await recoveredCorrupt.release();

  for (let round = 0; round < 30; round += 1) {
    await mkdir(join(root, ".run-lock"));
    await writeFile(
      join(root, ".run-lock", "owner.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 2_147_483_647,
        token: `stale-round-${round}`,
        startedAt: new Date(0).toISOString(),
      })}\n`,
    );
    const contenderResults = await Promise.all(
      Array.from({ length: 12 }, () => runContender(root)),
    );
    assert.equal(contenderResults.includes(9), false);
  }
  await access(join(root, "acquired"));
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stdout.write("Terminal-Bench publication lock boundary passed.\n");

function runContender(contenderRoot) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [import.meta.filename], {
      env: { ...process.env, PICO_TB_LOCK_CONTENDER_ROOT: contenderRoot },
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise(code));
  });
}

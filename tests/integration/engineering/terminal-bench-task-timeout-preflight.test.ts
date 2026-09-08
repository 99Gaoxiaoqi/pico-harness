import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

test("Terminal-Bench timeout preflight accepts 12000 seconds and rejects larger tasks", async (context) => {
  const dataset = await mkdtemp(join(tmpdir(), "pico-task-timeout-preflight-"));
  context.after(() => rm(dataset, { recursive: true, force: true }));
  await writeTask(dataset, "short-task", "900.0");
  await writeTask(dataset, "maximum-task", "12000.0");

  const accepted = await runPreflight(dataset);
  assert.deepEqual(JSON.parse(accepted.stdout), {
    maximumObservedAgentTimeoutSec: 12_000,
    maximumObservedVerifierTimeoutSec: 12_000,
    schemaVersion: 1,
    supportedMaximumAgentTimeoutSec: 12_000,
    supportedMaximumVerifierTimeoutSec: 12_000,
    taskCount: 2,
  });

  await writeTask(dataset, "unsupported-task", "12000.001", "900.0");
  await assert.rejects(runPreflight(dataset), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /unsupported-task.+at most 12000 seconds/u);
    return true;
  });

  await writeTask(dataset, "unsupported-task", "900.0", "12000.001");
  await assert.rejects(runPreflight(dataset), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /unsupported-task.+verifier.+at most 12000 seconds/u);
    return true;
  });
});

async function writeTask(
  dataset: string,
  name: string,
  timeout: string,
  verifierTimeout = timeout,
): Promise<void> {
  const taskDirectory = join(dataset, name);
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(
    join(taskDirectory, "task.toml"),
    `[agent]\ntimeout_sec = ${timeout}\n\n[verifier]\ntimeout_sec = ${verifierTimeout}\n`,
  );
}

function runPreflight(dataset: string) {
  return execFileAsync(
    "python3",
    ["-m", "benchmarks.terminal_bench_2_1.task_timeout_preflight", "--dataset", dataset],
    {
      cwd: process.cwd(),
      timeout: 30_000,
    },
  );
}

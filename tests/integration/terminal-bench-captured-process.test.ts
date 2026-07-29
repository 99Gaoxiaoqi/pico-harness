import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
// @ts-expect-error The benchmark orchestrator is intentionally plain Node ESM.
import { runCaptured } from "../../scripts/terminal-bench/captured-process.mjs";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test(
  "Terminal-Bench output cap confirms the whole child process group exited",
  { skip: process.platform === "win32" },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-tb21-process-group-"));
    const sentinel = join(root, "descendant-survived");
    context.after(() => rm(root, { recursive: true, force: true }));
    const descendant = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(
      sentinel,
    )}, "alive"), 400)`;
    const parent = `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });
      process.stdout.write("x".repeat(2048));
      setInterval(() => {}, 1000);
    `;

    await assert.rejects(
      runCaptured(process.execPath, ["-e", parent], root, process.env, "{}", {
        maxOutputBytes: 1024,
        processGroupExitTimeoutMs: 5_000,
      }),
      /output exceeded the benchmark capture limit/u,
    );
    await delay(600);
    await assert.rejects(access(sentinel), { code: "ENOENT" });
  },
);

test(
  "Terminal-Bench output cap deadline starts before inherited pipes close",
  { skip: process.platform === "win32" },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-tb21-output-deadline-"));
    const sentinel = join(root, "detached-descendant-finished");
    context.after(() => rm(root, { recursive: true, force: true }));
    const descendant = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(
      sentinel,
    )}, "finished"), 1200)`;
    const parent = `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
        detached: true,
        stdio: ["ignore", process.stdout, process.stderr],
      });
      process.stdout.write("x".repeat(2048));
      setInterval(() => {}, 1000);
    `;
    const startedAt = Date.now();

    await assert.rejects(
      runCaptured(process.execPath, ["-e", parent], root, process.env, "{}", {
        maxOutputBytes: 1024,
        processGroupExitTimeoutMs: 100,
      }),
      /output exceeded the benchmark capture limit/u,
    );
    assert.ok(
      Date.now() - startedAt < 800,
      "output-cap rejection waited for a detached descendant to close inherited pipes",
    );
    await delay(1400);
    await access(sentinel);
  },
);

test("Terminal-Bench passes an immutable dataset directory descriptor to Harbor", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "pico-tb21-dataset-fd-"));
  const root = join(parent, "dataset");
  const displaced = join(parent, "displaced");
  const probe = join(root, "probe");
  context.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(root);
  await writeFile(probe, "immutable");
  const directoryHandle = await open(root, "r");
  context.after(() => directoryHandle.close());
  const child =
    "import os, pathlib; os.fchdir(int(os.environ['DATASET_FD'])); " +
    "import time; time.sleep(0.3); print(pathlib.Path('probe').read_text(), end='')";

  const execution = runCaptured(
    "python3",
    ["-c", child],
    tmpdir(),
    { ...process.env, DATASET_FD: "4" },
    "{}",
    { inheritedFileDescriptors: [directoryHandle.fd] },
  );
  await delay(100);
  await rename(root, displaced);
  await mkdir(root);
  await writeFile(probe, "malicious");
  const result = await execution;

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "immutable");
});

test("Terminal-Bench registers a Compose project before Harbor environment construction", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-project-registry-"));
  const registry = join(root, "ownership.jsonl");
  context.after(() => rm(root, { recursive: true, force: true }));
  const script = `
from pathlib import Path
from benchmarks.terminal_bench_2_1.harbor_bootstrap import install_project_registration

registry = Path(${JSON.stringify(registry)})

class FakeDockerEnvironment:
    def __init__(self, *, session_id):
        records = registry.read_text().splitlines()
        assert len(records) == 1
        assert '"composeProject":"trial__env"' in records[0]

install_project_registration(FakeDockerEnvironment, registry, "run-1")
FakeDockerEnvironment(session_id="trial__env")
`;

  await execFile("python3", ["-c", script], {
    cwd: projectRoot,
    env: process.env,
  });
});

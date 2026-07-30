import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error The benchmark orchestrator is intentionally plain Node ESM.
import * as localDataset from "../../scripts/terminal-bench/local-dataset.mjs";
// @ts-expect-error The benchmark publisher is intentionally plain Node ESM.
import * as publication from "../../scripts/terminal-bench/publication.mjs";

const {
  localDatasetHarborArgs,
  prepareLocalDataset,
  resolveTaskCachePackagesRoot,
  resolveTaskLockPath,
} = localDataset;
const { hashDirectory } = publication;

test("Terminal-Bench selects mode-specific local locks and caches", () => {
  const projectRoot = join(tmpdir(), "pico-project");
  const homeDirectory = join(tmpdir(), "pico-home");

  assert.equal(
    resolveTaskLockPath(projectRoot, "canary"),
    join(projectRoot, "benchmarks", "terminal_bench_2_1", "canary-task-lock.json"),
  );
  assert.equal(
    resolveTaskLockPath(projectRoot, "full"),
    join(projectRoot, "benchmarks", "terminal_bench_2_1", "full-task-lock.json"),
  );
  assert.equal(
    resolveTaskCachePackagesRoot(projectRoot, "canary", homeDirectory),
    join(homeDirectory, ".cache", "harbor", "tasks", "packages"),
  );
  assert.equal(
    resolveTaskCachePackagesRoot(projectRoot, "full", homeDirectory),
    join(
      projectRoot,
      "output",
      "benchmarks",
      "terminal-bench-2.1",
      "cache",
      "harbor-tasks",
      "packages",
    ),
  );
});

test("Terminal-Bench full mode fails closed when its task lock is absent", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-full-lock-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    prepareLocalDataset({
      mode: "full",
      tasks: ["terminal-bench/fixture"],
      projectRoot: root,
      runRoot: join(root, "run"),
      runId: "fixture-run",
      homeDirectory: join(root, "home"),
      env: {},
    }),
    /full task lock is unavailable/u,
  );
});

test("Terminal-Bench full mode stages and isolates every locked local task", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-full-stage-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const taskName = "terminal-bench/fixture";
  const cacheDigest = "a".repeat(64);
  const source = join(
    root,
    "output",
    "benchmarks",
    "terminal-bench-2.1",
    "cache",
    "harbor-tasks",
    "packages",
    "terminal-bench",
    "fixture",
    cacheDigest,
  );
  await mkdir(join(source, "environment"), { recursive: true });
  await writeFile(join(source, "task.toml"), 'instruction = "fixture"\n');
  const treeSha256 = await hashDirectory(source);
  const lockPath = join(root, "benchmarks", "terminal_bench_2_1", "full-task-lock.json");
  await mkdir(join(root, "benchmarks", "terminal_bench_2_1"), { recursive: true });
  await writeFile(
    lockPath,
    `${JSON.stringify({
      schemaVersion: 1,
      tasks: {
        [taskName]: { cacheDigest, treeSha256 },
      },
    })}\n`,
  );

  const result = await prepareLocalDataset({
    mode: "full",
    tasks: [taskName],
    projectRoot: root,
    runRoot: join(root, "run"),
    runId: "fixture-run",
    homeDirectory: join(root, "home"),
    env: {},
  });

  assert.equal(result.taskLockPath, lockPath);
  assert.match(result.taskLockSha256, /^[0-9a-f]{64}$/u);
  assert.match(
    await readFile(join(result.path, "fixture", "environment", "docker-compose.yaml"), "utf8"),
    /internal: true/u,
  );
});

test("Terminal-Bench Harbor invocation has no remote dataset fallback", () => {
  assert.throws(() => localDatasetHarborArgs(null), /requires a verified local dataset snapshot/u);
  const args = localDatasetHarborArgs("/verified/read-only-dataset");
  assert.deepEqual(args, ["--path", "."]);
  assert.doesNotMatch(args.join(" "), /--dataset/u);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error The benchmark orchestrator is intentionally plain Node ESM.
import * as egressPolicy from "../../scripts/terminal-bench/egress-policy.mjs";
// @ts-expect-error The benchmark orchestrator is intentionally plain Node ESM.
import * as localDataset from "../../scripts/terminal-bench/local-dataset.mjs";
// @ts-expect-error The benchmark publisher is intentionally plain Node ESM.
import * as publication from "../../scripts/terminal-bench/publication.mjs";

const {
  benchmarkPublicEgressMaxTotalBytes,
  buildEgressPolicyManifest,
  parseTaskAllowInternet,
  publicEgressDnsPolicy,
  publicEgressLimits,
  publicEgressProxyPolicyVersion,
} = egressPolicy;
const {
  localDatasetHarborArgs,
  prepareLocalDataset,
  resolveImageLockPath,
  resolveTaskCachePackagesRoot,
  resolveTaskLockPath,
} = localDataset;
const { hashDirectory } = publication;
const fullTaskCount = 89;
const imagePlatform = "linux/amd64";

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
    resolveTaskLockPath(projectRoot, "cached-full"),
    join(projectRoot, "benchmarks", "terminal_bench_2_1", "full-task-lock.json"),
  );
  assert.equal(resolveImageLockPath(projectRoot, "canary"), null);
  assert.equal(
    resolveImageLockPath(projectRoot, "full"),
    join(projectRoot, "benchmarks", "terminal_bench_2_1", "full-image-lock.json"),
  );
  assert.equal(
    resolveImageLockPath(projectRoot, "cached-full"),
    join(projectRoot, "benchmarks", "terminal_bench_2_1", "full-image-lock.json"),
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
  assert.equal(
    resolveTaskCachePackagesRoot(projectRoot, "cached-full", homeDirectory),
    resolveTaskCachePackagesRoot(projectRoot, "full", homeDirectory),
  );
});

test("Terminal-Bench full mode still rejects a task subset", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-full-subset-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const tasks = fullFixtureTasks();
  await writeFullTaskList(root, tasks);

  await assert.rejects(
    prepareLocalDataset({
      mode: "full",
      tasks: tasks.slice(0, 2),
      projectRoot: root,
      runRoot: join(root, "run"),
      runId: "fixture-run",
      homeDirectory: join(root, "home"),
      env: {},
    }),
    /full task set does not match the fixed 89-task list/u,
  );
});

test("Terminal-Bench full mode fails closed when its task lock is absent", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-full-lock-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const tasks = fullFixtureTasks();
  await writeFullTaskList(root, tasks);

  await assert.rejects(
    prepareLocalDataset({
      mode: "full",
      tasks,
      projectRoot: root,
      runRoot: join(root, "run"),
      runId: "fixture-run",
      homeDirectory: join(root, "home"),
      env: {},
    }),
    /full task lock is unavailable/u,
  );
});

test("Terminal-Bench full mode fails closed when its image lock is absent", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-full-image-lock-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const tasks = fullFixtureTasks();
  await writeFullTaskList(root, tasks);
  await writeTaskLock(
    root,
    Object.fromEntries(
      tasks.map((taskName, index) => [
        taskName,
        { cacheDigest: fixtureHash(index), treeSha256: fixtureHash(index + 100) },
      ]),
    ),
  );

  await assert.rejects(
    prepareLocalDataset({
      mode: "full",
      tasks,
      projectRoot: root,
      runRoot: join(root, "run"),
      runId: "fixture-run",
      homeDirectory: join(root, "home"),
      env: {},
    }),
    /full image lock is unavailable/u,
  );
});

test("Terminal-Bench full mode rejects an image source mismatch", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-full-image-source-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const tasks = fullFixtureTasks();
  const firstTask = tasks[0];
  assert.ok(firstTask);
  const cacheDigest = fixtureHash(1);
  const source = await writeCachedTask(
    root,
    firstTask,
    cacheDigest,
    "registry.example/terminal-bench/fixture-00:source",
  );
  const treeSha256 = await hashDirectory(source);
  const taskEntries = Object.fromEntries(
    tasks.map((taskName, index) => [
      taskName,
      {
        cacheDigest: taskName === firstTask ? cacheDigest : fixtureHash(index + 2),
        treeSha256: taskName === firstTask ? treeSha256 : fixtureHash(index + 200),
      },
    ]),
  );
  const imageEntries = imageLockEntries(tasks);
  const firstImage = imageEntries[firstTask];
  assert.ok(firstImage);
  imageEntries[firstTask] = {
    ...firstImage,
    source: "registry.example/terminal-bench/fixture-00:different",
  };
  await writeFullTaskList(root, tasks);
  await writeTaskLock(root, taskEntries);
  await writeImageLock(root, imageEntries);

  await assert.rejects(
    prepareLocalDataset({
      mode: "full",
      tasks,
      projectRoot: root,
      runRoot: join(root, "run"),
      runId: "fixture-run",
      homeDirectory: join(root, "home"),
      env: {},
    }),
    /task image source mismatch/u,
  );
});

test("Terminal-Bench full mode pins every staged image by digest before isolation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-full-stage-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const tasks = fullFixtureTasks();
  const taskEntries: Record<string, { cacheDigest: string; treeSha256: string }> = {};
  const imageEntries = imageLockEntries(tasks);
  for (const [index, taskName] of tasks.entries()) {
    const cacheDigest = fixtureHash(index + 1);
    const image = imageEntries[taskName];
    assert.ok(image);
    const source = await writeCachedTask(root, taskName, cacheDigest, image.source);
    taskEntries[taskName] = {
      cacheDigest,
      treeSha256: await hashDirectory(source),
    };
  }
  await writeFullTaskList(root, tasks);
  const lockPath = await writeTaskLock(root, taskEntries);
  const imageLockPath = await writeImageLock(root, imageEntries);

  const result = await prepareLocalDataset({
    mode: "full",
    tasks,
    projectRoot: root,
    runRoot: join(root, "run"),
    runId: "fixture-run",
    homeDirectory: join(root, "home"),
    env: {},
  });

  assert.equal(result.taskLockPath, lockPath);
  assert.match(result.taskLockSha256, /^[0-9a-f]{64}$/u);
  assert.equal(result.imageLockPath, imageLockPath);
  assert.match(result.imageLockSha256, /^[0-9a-f]{64}$/u);
  assert.equal(result.imageLockPlatform, imagePlatform);
  assert.equal(Object.keys(result.egressPolicyByTask).length, fullTaskCount);
  for (const taskName of tasks) {
    const shortName = taskName.slice("terminal-bench/".length);
    const taskToml = await readFile(join(result.path, shortName, "task.toml"), "utf8");
    const expected = imageEntries[taskName];
    assert.ok(expected);
    assert.deepEqual(result.egressPolicyByTask[taskName], { allowInternet: true });
    assert.match(taskToml, new RegExp(`docker_image = "${pinnedImage(expected)}"`, "u"));
    assert.match(
      await readFile(join(result.path, shortName, "environment", "docker-compose.yaml"), "utf8"),
      /internal: true/u,
    );
  }
});

test("Terminal-Bench cached-full stages a locked subset without image pulls", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-cached-full-stage-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fullTasks = fullFixtureTasks();
  const selectedTasks = fullTasks.slice(0, 2);
  const imageEntries = imageLockEntries(fullTasks);
  const taskEntries = Object.fromEntries(
    fullTasks.map((taskName, index) => [
      taskName,
      {
        cacheDigest: fixtureHash(index + 1),
        treeSha256: fixtureHash(index + 500),
      },
    ]),
  );
  for (const [index, taskName] of selectedTasks.entries()) {
    const image = imageEntries[taskName];
    assert.ok(image);
    const cacheDigest = fixtureHash(index + 1);
    const source = await writeCachedTask(root, taskName, cacheDigest, image.source);
    taskEntries[taskName] = {
      cacheDigest,
      treeSha256: await hashDirectory(source),
    };
  }
  await writeFullTaskList(root, fullTasks);
  await writeTaskLock(root, taskEntries);
  await writeImageLock(root, imageEntries);

  const result = await prepareLocalDataset({
    mode: "cached-full",
    tasks: selectedTasks,
    projectRoot: root,
    runRoot: join(root, "run"),
    runId: "fixture-run",
    homeDirectory: join(root, "home"),
    env: {},
  });

  for (const taskName of selectedTasks) {
    const shortName = taskName.slice("terminal-bench/".length);
    const compose = await readFile(
      join(result.path, shortName, "environment", "docker-compose.yaml"),
      "utf8",
    );
    assert.match(compose, /pull_policy: never/u);
    assert.match(compose, /internal: true/u);
  }
  assert.deepEqual(Object.keys(result.egressPolicyByTask), selectedTasks);
  assert.deepEqual(
    Object.values(result.egressPolicyByTask),
    selectedTasks.map(() => ({ allowInternet: true })),
  );
});

test("Terminal-Bench cached-full rejects a substituted task lock before staging a subset", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-cached-full-lock-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fullTasks = fullFixtureTasks();
  const selectedTask = fullTasks[0];
  assert.ok(selectedTask);
  await writeFullTaskList(root, fullTasks);
  const taskEntries = Object.fromEntries(
    fullTasks.map((taskName, index) => [
      taskName,
      {
        cacheDigest: fixtureHash(index + 1),
        treeSha256: fixtureHash(index + 500),
      },
    ]),
  );
  const replacedTask = fullTasks.at(-1);
  assert.ok(replacedTask);
  delete taskEntries[replacedTask];
  taskEntries["terminal-bench/outside-fixed-matrix"] = {
    cacheDigest: fixtureHash(1_000),
    treeSha256: fixtureHash(1_001),
  };
  assert.equal(Object.keys(taskEntries).length, fullTaskCount);
  await writeTaskLock(root, taskEntries);

  await assert.rejects(
    prepareLocalDataset({
      mode: "cached-full",
      tasks: [selectedTask],
      projectRoot: root,
      runRoot: join(root, "run"),
      runId: "fixture-run",
      homeDirectory: join(root, "home"),
      env: {},
    }),
    /cached-full task lock does not cover the task list/u,
  );
});

test("Terminal-Bench single mode does not require or report an image lock", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-single-stage-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const homeDirectory = join(root, "home");
  const taskName = "terminal-bench/fixture";
  const cacheDigest = fixtureHash(1);
  const source = join(
    homeDirectory,
    ".cache",
    "harbor",
    "tasks",
    "packages",
    "terminal-bench",
    "fixture",
    cacheDigest,
  );
  await mkdir(join(source, "environment"), { recursive: true });
  await writeFile(
    join(source, "task.toml"),
    'instruction = "fixture"\n\n[environment]\nallow_internet = false\n',
  );
  const treeSha256 = await hashDirectory(source);
  const lockPath = join(root, "benchmarks", "terminal_bench_2_1", "canary-task-lock.json");
  await mkdir(join(root, "benchmarks", "terminal_bench_2_1"), { recursive: true });
  await writeFile(
    lockPath,
    `${JSON.stringify({
      schemaVersion: 1,
      tasks: { [taskName]: { cacheDigest, treeSha256 } },
    })}\n`,
  );

  const result = await prepareLocalDataset({
    mode: "single",
    tasks: [taskName],
    projectRoot: root,
    runRoot: join(root, "run"),
    runId: "fixture-run",
    homeDirectory,
    env: {},
  });

  assert.equal(result.imageLockPath, null);
  assert.equal(result.imageLockSha256, null);
  assert.equal(result.imageLockPlatform, null);
  assert.deepEqual(result.egressPolicyByTask, {
    [taskName]: { allowInternet: false },
  });
  assert.equal(
    await readFile(join(result.path, "fixture", "task.toml"), "utf8"),
    'instruction = "fixture"\n\n[environment]\nallow_internet = false\n',
  );
});

test("Terminal-Bench parses one strict allow_internet boolean from [environment]", () => {
  assert.equal(
    parseTaskAllowInternet(
      [
        'instruction = """',
        "[environment]",
        "allow_internet = false",
        '"""',
        "[environment]",
        "allow_internet = true # locked task declaration",
      ].join("\n"),
      "terminal-bench/true-fixture",
    ),
    true,
  );
  assert.equal(
    parseTaskAllowInternet(
      "[environment]\nallow_internet = false\n",
      "terminal-bench/false-fixture",
    ),
    false,
  );
});

test("Terminal-Bench egress policy fails closed for malformed task.toml declarations", () => {
  const invalidTaskTomls = [
    'instruction = "missing environment and policy"\n',
    "[environment]\ncpus = 1\n",
    "[environment]\nallow_internet = true\nallow_internet = false\n",
    '[environment]\nallow_internet = "true"\n',
    "[environment]\nallow_internet = 1\n",
    "[environment]\nallow_internet = true\n[environment]\nallow_internet = true\n",
    '[environment]\nallow_internet = true\ninstruction = "unterminated\n',
  ];
  for (const taskToml of invalidTaskTomls) {
    assert.throws(
      () => parseTaskAllowInternet(taskToml, "terminal-bench/malformed-fixture"),
      /egress policy is invalid/u,
    );
  }
});

test("Terminal-Bench serializes an exact, versioned public egress manifest", () => {
  const tasks = ["terminal-bench/online", "terminal-bench/offline"];
  const manifest = buildEgressPolicyManifest(tasks, {
    "terminal-bench/online": { allowInternet: true },
    "terminal-bench/offline": { allowInternet: false },
  });

  assert.deepEqual(manifest, {
    proxyPolicyVersion: publicEgressProxyPolicyVersion,
    limits: {
      maxConnections: publicEgressLimits.maxConnections,
      maxRequests: publicEgressLimits.maxRequests,
      maxTotalBytes: publicEgressLimits.maxTotalBytes,
      connectionTimeoutSec: publicEgressLimits.connectionTimeoutSec,
      maxAuditDecisions: publicEgressLimits.maxAuditDecisions,
      allowedHttpPorts: [80],
      allowedConnectPorts: [443],
    },
    dns: {
      mode: publicEgressDnsPolicy.mode,
      host: publicEgressDnsPolicy.host,
      endpointIps: [...publicEgressDnsPolicy.endpointIps],
      systemFallback: publicEgressDnsPolicy.systemFallback,
      ipv4Only: publicEgressDnsPolicy.ipv4Only,
    },
    tasks: [
      { taskName: "terminal-bench/online", allowInternet: true },
      { taskName: "terminal-bench/offline", allowInternet: false },
    ],
  });
  assert.equal(publicEgressLimits.maxTotalBytes, 1_073_741_824);
  assert.equal(benchmarkPublicEgressMaxTotalBytes, 2_147_483_648);

  const benchmarkManifest = buildEgressPolicyManifest(
    tasks,
    {
      "terminal-bench/online": { allowInternet: true },
      "terminal-bench/offline": { allowInternet: false },
    },
    { maxTotalBytes: benchmarkPublicEgressMaxTotalBytes },
  );
  assert.equal(benchmarkManifest.limits.maxTotalBytes, 2_147_483_648);
  for (const invalidOverrides of [
    null,
    {},
    { maxTotalBytes: 1_073_741_823 },
    { maxTotalBytes: 2_147_483_649 },
    { maxTotalBytes: true },
    { maxTotalBytes: 2_147_483_648, maxRequests: 4_096 },
  ]) {
    assert.throws(
      () =>
        buildEgressPolicyManifest(
          tasks,
          {
            "terminal-bench/online": { allowInternet: true },
            "terminal-bench/offline": { allowInternet: false },
          },
          invalidOverrides,
        ),
      /egress .* override/u,
    );
  }
  assert.throws(
    () =>
      buildEgressPolicyManifest(tasks, {
        "terminal-bench/online": { allowInternet: true },
      }),
    /does not match the exact task list/u,
  );
  assert.throws(
    () =>
      buildEgressPolicyManifest(tasks, {
        "terminal-bench/online": { allowInternet: true },
        "terminal-bench/offline": { allowInternet: false },
        "terminal-bench/unknown": { allowInternet: false },
      }),
    /does not match the exact task list/u,
  );
});

test("Terminal-Bench Harbor invocation has no remote dataset fallback", () => {
  assert.throws(() => localDatasetHarborArgs(null), /requires a verified local dataset snapshot/u);
  const args = localDatasetHarborArgs("/verified/read-only-dataset");
  assert.deepEqual(args, ["--path", "."]);
  assert.doesNotMatch(args.join(" "), /--dataset/u);
});

function fullFixtureTasks() {
  return Array.from(
    { length: fullTaskCount },
    (_, index) => `terminal-bench/fixture-${String(index).padStart(2, "0")}`,
  );
}

function fixtureHash(index: number) {
  return index.toString(16).padStart(64, "0");
}

function imageLockEntries(tasks: string[]) {
  return Object.fromEntries(
    tasks.map((taskName, index) => [
      taskName,
      {
        source: `registry.example/terminal-bench/${taskName.slice(
          "terminal-bench/".length,
        )}:20260730`,
        digest: `sha256:${fixtureHash(index + 1_000)}`,
        compressedSizeBytes: index + 1,
      },
    ]),
  );
}

async function writeFullTaskList(root: string, tasks: string[]) {
  const directory = join(root, "benchmarks", "terminal_bench_2_1");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "full-task-names.txt"), `${tasks.join("\n")}\n`);
}

async function writeTaskLock(
  root: string,
  tasks: Record<string, { cacheDigest: string; treeSha256: string }>,
) {
  const path = join(root, "benchmarks", "terminal_bench_2_1", "full-task-lock.json");
  await mkdir(join(root, "benchmarks", "terminal_bench_2_1"), { recursive: true });
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, tasks })}\n`);
  return path;
}

async function writeImageLock(
  root: string,
  images: Record<string, { source: string; digest: string; compressedSizeBytes: number }>,
) {
  const path = join(root, "benchmarks", "terminal_bench_2_1", "full-image-lock.json");
  await mkdir(join(root, "benchmarks", "terminal_bench_2_1"), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ schemaVersion: 1, platform: imagePlatform, images })}\n`,
  );
  return path;
}

async function writeCachedTask(
  root: string,
  taskName: string,
  cacheDigest: string,
  imageSource: string,
) {
  const shortName = taskName.slice("terminal-bench/".length);
  const source = join(
    root,
    "output",
    "benchmarks",
    "terminal-bench-2.1",
    "cache",
    "harbor-tasks",
    "packages",
    "terminal-bench",
    shortName,
    cacheDigest,
  );
  await mkdir(join(source, "environment"), { recursive: true });
  await writeFile(
    join(source, "task.toml"),
    `[environment]\ndocker_image = "${imageSource}"\nallow_internet = true\n`,
  );
  return source;
}

function pinnedImage(image: { source: string; digest: string }) {
  return `${image.source.slice(0, image.source.lastIndexOf(":"))}@${image.digest}`;
}

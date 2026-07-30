import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertTaskComposePolicy, prestartNetworkOverlay } from "./container-policy.mjs";
import { allowlistedHostEnv } from "./host-secret-boundary.mjs";
import { hashDirectory } from "./publication.mjs";

const taskLockFiles = {
  single: "canary-task-lock.json",
  canary: "canary-task-lock.json",
  full: "full-task-lock.json",
};

export function resolveTaskLockPath(projectRoot, mode) {
  const filename = taskLockFiles[mode];
  if (filename === undefined) {
    throw new Error(`Terminal-Bench dataset mode is unsupported: ${mode}`);
  }
  return join(projectRoot, "benchmarks", "terminal_bench_2_1", filename);
}

export function resolveTaskCachePackagesRoot(projectRoot, mode, homeDirectory = homedir()) {
  if (mode === "full") {
    return join(
      projectRoot,
      "output",
      "benchmarks",
      "terminal-bench-2.1",
      "cache",
      "harbor-tasks",
      "packages",
    );
  }
  if (mode === "single" || mode === "canary") {
    return join(homeDirectory, ".cache", "harbor", "tasks", "packages");
  }
  throw new Error(`Terminal-Bench dataset mode is unsupported: ${mode}`);
}

export function localDatasetHarborArgs(localDatasetPath) {
  if (typeof localDatasetPath !== "string" || localDatasetPath.length === 0) {
    throw new Error("Terminal-Bench requires a verified local dataset snapshot");
  }
  return ["--path", "."];
}

export async function prepareLocalDataset({
  mode,
  tasks,
  projectRoot,
  runRoot,
  runId,
  env = process.env,
  homeDirectory = homedir(),
}) {
  const taskLockPath = resolveTaskLockPath(projectRoot, mode);
  const taskLockRaw = await readRequiredTaskLock(taskLockPath, mode);
  const taskLock = parseTaskLock(taskLockRaw, mode);
  assertCompleteModeLock(taskLock, tasks, mode);
  const cachePackagesRoot = resolveTaskCachePackagesRoot(projectRoot, mode, homeDirectory);
  const destination = join(runRoot, "local-dataset");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const taskName of tasks) {
    const expected = taskLock.tasks[taskName];
    if (
      !expected ||
      !/^[0-9a-f]{64}$/u.test(expected.cacheDigest) ||
      !/^[0-9a-f]{64}$/u.test(expected.treeSha256)
    ) {
      throw new Error(`Terminal-Bench task is absent from the ${mode} lock: ${taskName}`);
    }
    if (!/^terminal-bench\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(taskName)) {
      throw new Error(`Terminal-Bench task name is invalid: ${taskName}`);
    }
    const shortName = taskName.slice("terminal-bench/".length);
    const source = join(cachePackagesRoot, "terminal-bench", shortName, expected.cacheDigest);
    let sourceTreeSha256;
    try {
      sourceTreeSha256 = await hashDirectory(source);
    } catch (error) {
      throw new Error(`Terminal-Bench cached task is unavailable: ${taskName}`, {
        cause: error,
      });
    }
    if (sourceTreeSha256 !== expected.treeSha256) {
      throw new Error(`Terminal-Bench cached task digest mismatch: ${taskName}`);
    }
    const taskDestination = join(destination, shortName);
    await cp(source, taskDestination, { recursive: true, errorOnExist: true });
    if ((await hashDirectory(taskDestination)) !== expected.treeSha256) {
      throw new Error(`Terminal-Bench staged task digest mismatch: ${taskName}`);
    }
    await setTaskPrestartNetworkIsolation(taskDestination, runId);
    await assertTaskComposePolicy(taskDestination, allowlistedHostEnv(env));
  }
  return {
    path: destination,
    taskLockPath,
    taskLockSha256: createHash("sha256").update(taskLockRaw).digest("hex"),
  };
}

async function readRequiredTaskLock(path, mode) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Terminal-Bench ${mode} task lock is unavailable: ${path}`, {
        cause: error,
      });
    }
    throw error;
  }
}

function parseTaskLock(raw, mode) {
  let lock;
  try {
    lock = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new Error(`Terminal-Bench ${mode} task lock is invalid JSON`, { cause: error });
  }
  if (
    lock?.schemaVersion !== 1 ||
    lock.tasks === null ||
    typeof lock.tasks !== "object" ||
    Array.isArray(lock.tasks)
  ) {
    throw new Error(`Terminal-Bench ${mode} task lock is invalid`);
  }
  return lock;
}

function assertCompleteModeLock(lock, tasks, mode) {
  if (!Array.isArray(tasks) || tasks.length === 0 || new Set(tasks).size !== tasks.length) {
    throw new Error(`Terminal-Bench ${mode} tasks are invalid`);
  }
  if (mode === "single") return;
  const lockedTasks = Object.keys(lock.tasks);
  if (
    lockedTasks.length !== tasks.length ||
    tasks.some((taskName) => !Object.hasOwn(lock.tasks, taskName))
  ) {
    throw new Error(`Terminal-Bench ${mode} task lock does not match the task list`);
  }
}

async function setTaskPrestartNetworkIsolation(taskRoot, runId) {
  const path = join(taskRoot, "environment", "docker-compose.yaml");
  try {
    await lstat(path);
    throw new Error("Terminal-Bench task defines unsupported Compose services");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeFile(path, prestartNetworkOverlay(runId), { mode: 0o600 });
}

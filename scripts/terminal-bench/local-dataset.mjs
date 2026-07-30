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
const fullImageLockFilename = "full-image-lock.json";
const fullTaskListFilename = "full-task-names.txt";
const fullTaskCount = 89;
const fullImagePlatform = "linux/amd64";
const taskNamePattern = /^terminal-bench\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const imageDigestPattern = /^sha256:[0-9a-f]{64}$/u;

export function resolveTaskLockPath(projectRoot, mode) {
  const filename = taskLockFiles[mode];
  if (filename === undefined) {
    throw new Error(`Terminal-Bench dataset mode is unsupported: ${mode}`);
  }
  return join(projectRoot, "benchmarks", "terminal_bench_2_1", filename);
}

export function resolveImageLockPath(projectRoot, mode) {
  if (mode === "full") {
    return join(projectRoot, "benchmarks", "terminal_bench_2_1", fullImageLockFilename);
  }
  if (mode === "single" || mode === "canary") return null;
  throw new Error(`Terminal-Bench dataset mode is unsupported: ${mode}`);
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
  assertValidTasks(tasks, mode);
  if (mode === "full") await assertFullTaskMatrix(projectRoot, tasks);
  const taskLockPath = resolveTaskLockPath(projectRoot, mode);
  const taskLockRaw = await readRequiredTaskLock(taskLockPath, mode);
  const taskLock = parseTaskLock(taskLockRaw, mode);
  assertCompleteModeLock(taskLock, tasks, mode);
  const imageLock = await readImageLock(projectRoot, tasks, mode);
  const cachePackagesRoot = resolveTaskCachePackagesRoot(projectRoot, mode, homeDirectory);
  const destination = join(runRoot, "local-dataset");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const taskName of tasks) {
    const expected = taskLock.tasks[taskName];
    if (
      !expected ||
      !sha256Pattern.test(expected.cacheDigest) ||
      !sha256Pattern.test(expected.treeSha256)
    ) {
      throw new Error(`Terminal-Bench task is absent from the ${mode} lock: ${taskName}`);
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
    if (imageLock.lock !== null) {
      await pinTaskDockerImage(taskDestination, taskName, imageLock.lock.images[taskName]);
    }
    await setTaskPrestartNetworkIsolation(taskDestination, runId);
    await assertTaskComposePolicy(taskDestination, allowlistedHostEnv(env));
  }
  return {
    path: destination,
    taskLockPath,
    taskLockSha256: createHash("sha256").update(taskLockRaw).digest("hex"),
    imageLockPath: imageLock.path,
    imageLockSha256: imageLock.sha256,
    imageLockPlatform: imageLock.platform,
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
  if (mode === "single") return;
  const lockedTasks = Object.keys(lock.tasks);
  if (
    lockedTasks.length !== tasks.length ||
    tasks.some((taskName) => !Object.hasOwn(lock.tasks, taskName))
  ) {
    throw new Error(`Terminal-Bench ${mode} task lock does not match the task list`);
  }
}

function assertValidTasks(tasks, mode) {
  if (
    !Array.isArray(tasks) ||
    tasks.length === 0 ||
    new Set(tasks).size !== tasks.length ||
    tasks.some((taskName) => typeof taskName !== "string" || !taskNamePattern.test(taskName))
  ) {
    throw new Error(`Terminal-Bench ${mode} tasks are invalid`);
  }
}

async function assertFullTaskMatrix(projectRoot, tasks) {
  const path = join(projectRoot, "benchmarks", "terminal_bench_2_1", fullTaskListFilename);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Terminal-Bench full task list is unavailable: ${path}`, {
        cause: error,
      });
    }
    throw error;
  }
  const expectedTasks = raw
    .split(/\r?\n/u)
    .map((taskName) => taskName.trim())
    .filter(Boolean);
  if (
    expectedTasks.length !== fullTaskCount ||
    new Set(expectedTasks).size !== fullTaskCount ||
    expectedTasks.some((taskName) => !taskNamePattern.test(taskName)) ||
    tasks.length !== fullTaskCount ||
    tasks.some((taskName) => !expectedTasks.includes(taskName))
  ) {
    throw new Error("Terminal-Bench full task set does not match the fixed 89-task list");
  }
}

async function readImageLock(projectRoot, tasks, mode) {
  const path = resolveImageLockPath(projectRoot, mode);
  if (path === null) {
    return { lock: null, path: null, sha256: null, platform: null };
  }
  let raw;
  try {
    raw = await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Terminal-Bench full image lock is unavailable: ${path}`, {
        cause: error,
      });
    }
    throw error;
  }
  let lock;
  try {
    lock = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new Error("Terminal-Bench full image lock is invalid JSON", { cause: error });
  }
  if (
    lock?.schemaVersion !== 1 ||
    lock.platform !== fullImagePlatform ||
    lock.images === null ||
    typeof lock.images !== "object" ||
    Array.isArray(lock.images)
  ) {
    throw new Error("Terminal-Bench full image lock is invalid");
  }
  const lockedTasks = Object.keys(lock.images);
  if (
    lockedTasks.length !== tasks.length ||
    tasks.some((taskName) => !Object.hasOwn(lock.images, taskName))
  ) {
    throw new Error("Terminal-Bench full image lock does not match the task list");
  }
  for (const taskName of tasks) {
    const image = lock.images[taskName];
    if (
      image === null ||
      typeof image !== "object" ||
      Array.isArray(image) ||
      typeof image.source !== "string" ||
      !imageDigestPattern.test(image.digest) ||
      !Number.isSafeInteger(image.compressedSizeBytes) ||
      image.compressedSizeBytes <= 0
    ) {
      throw new Error(`Terminal-Bench full image lock entry is invalid: ${taskName}`);
    }
    taggedImageRepository(image.source, taskName);
  }
  return {
    lock,
    path,
    sha256: createHash("sha256").update(raw).digest("hex"),
    platform: lock.platform,
  };
}

async function pinTaskDockerImage(taskRoot, taskName, image) {
  const path = join(taskRoot, "task.toml");
  let taskToml;
  try {
    taskToml = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Terminal-Bench task.toml is unavailable: ${taskName}`, {
      cause: error,
    });
  }
  const assignments = [...taskToml.matchAll(/^[\t ]*docker_image[\t ]*=.*$/gmu)];
  if (assignments.length !== 1) {
    throw new Error(`Terminal-Bench task.toml must define exactly one docker_image: ${taskName}`);
  }
  const assignment = assignments[0];
  const parsed = assignment[0].match(
    /^([\t ]*docker_image[\t ]*=[\t ]*")([^"\r\n]+)("[\t ]*(?:#[^\r\n]*)?)$/u,
  );
  if (parsed === null || parsed[2] !== image.source) {
    throw new Error(`Terminal-Bench task image source mismatch: ${taskName}`);
  }
  const repository = taggedImageRepository(image.source, taskName);
  const pinned = `${repository}@${image.digest}`;
  const replacement = `${parsed[1]}${pinned}${parsed[3]}`;
  const start = assignment.index;
  const updated = `${taskToml.slice(0, start)}${replacement}${taskToml.slice(
    start + assignment[0].length,
  )}`;
  await writeFile(path, updated);
}

function taggedImageRepository(source, taskName) {
  if (source.length === 0 || source.includes("@") || /[\s"'\\]/u.test(source)) {
    throw new Error(`Terminal-Bench full image source is not a tagged reference: ${taskName}`);
  }
  const lastSlash = source.lastIndexOf("/");
  const tagSeparator = source.lastIndexOf(":");
  const repository = source.slice(0, tagSeparator);
  const tag = source.slice(tagSeparator + 1);
  if (
    tagSeparator <= lastSlash ||
    repository.length === 0 ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u.test(tag)
  ) {
    throw new Error(`Terminal-Bench full image source is not a tagged reference: ${taskName}`);
  }
  return repository;
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

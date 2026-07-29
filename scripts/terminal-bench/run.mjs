import { createHash, createHmac, randomBytes } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { rmSync } from "node:fs";
import { buildPicoBundle } from "./build-bundle.mjs";
import { assertTaskComposePolicy } from "./container-policy.mjs";
import { allowlistedHostEnv } from "./host-secret-boundary.mjs";
import { normalizeHarborJob } from "./normalize-results.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const datasetRef =
  "terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a";
const datasetSourceCommit = "5c8eadf1f393183288fa08b8f73ca9a469cc5e00";
const harborVersion = "0.20.0";
const harborCommit = "459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc";
const harborWheelSha256 = "4b7e48223aea2384cdb8c9eff35eaebd482fc9b1ec09f8193a121c47356ff19a";
const harborWheelUrl =
  "https://files.pythonhosted.org/packages/76/03/b6617f32385295729f3af0ae0d512cf87ba4793b9ce462ea020d776a9025/harbor-0.20.0-py3-none-any.whl";
const benchmarkApiKeyEnv = "PICO_TB_PROVIDER_API_KEY";
const nodeArchives = {
  x64: {
    name: "node-v22.14.0-linux-x64.tar.gz",
    sha256: "9d942932535988091034dc94cc5f42b6dc8784d6366df3a36c4c9ccb3996f0c2",
  },
  arm64: {
    name: "node-v22.14.0-linux-arm64.tar.gz",
    sha256: "8cf30ff7250f9463b53c18f89c6c606dfda70378215b2c905d0a9a8b08bd45e0",
  },
};

const options = parseArgs(process.argv.slice(2));
const envFile = resolve(options.envFile ?? join(projectRoot, ".env"));
process.loadEnvFile(envFile);
const userConfigPath = resolve(options.config ?? join(homedir(), ".pico", "config.json"));
const userConfig = JSON.parse(await readFile(userConfigPath, "utf8"));
const modelRouteId = options.modelRouteId ?? userConfig.defaults?.modelRouteId;
if (typeof modelRouteId !== "string" || !modelRouteId.includes("/")) {
  throw new Error("A model route is required");
}
const slash = modelRouteId.indexOf("/");
const providerId = modelRouteId.slice(0, slash);
const model = modelRouteId.slice(slash + 1);
const provider = structuredClone(userConfig.providers?.[providerId]);
if (!provider || typeof provider !== "object") {
  throw new Error("The selected route must identify a configured provider");
}
if (!Array.isArray(provider.models) || !provider.models.includes(model)) {
  throw new Error("The selected model is not declared by the provider");
}
assertLoopbackAllowed(provider.baseURL, options.dockerHostGateway);
provider.discoverModels ??= false;
const sourceApiKeyEnv = provider.apiKeyEnv;
const providerSecret =
  typeof provider.apiKey === "string" && provider.apiKey.length > 0
    ? provider.apiKey
    : typeof sourceApiKeyEnv === "string"
      ? process.env[sourceApiKeyEnv]
      : undefined;
if (!providerSecret) {
  throw new Error("The selected provider credential is unavailable");
}
delete provider.apiKey;
provider.apiKeyEnv = benchmarkApiKeyEnv;
const harborEnv = {
  ...allowlistedHostEnv(process.env),
  PYTHONPATH: [projectRoot, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
};

const picoCommit = (await capture("git", ["rev-parse", "HEAD"], projectRoot)).trim();
const dirty = (await capture("git", ["status", "--porcelain"], projectRoot)).trim().length > 0;
if (dirty) throw new Error("Benchmark runs require a clean Pico worktree");
const mode = options.mode ?? "canary";
const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
const runId = `${mode}-${timestamp}-${picoCommit.slice(0, 12)}`;
const benchmarkRoot = join(projectRoot, "output", "benchmarks", "terminal-bench-2.1");
const runsRoot = join(benchmarkRoot, "runs");
const workRunsRoot = join(benchmarkRoot, "work");
const quarantineRoot = join(benchmarkRoot, "quarantine");
const runRoot = join(workRunsRoot, runId);
const publishedRunRoot = join(runsRoot, runId);
await mkdir(runsRoot, { recursive: true, mode: 0o700 });
await mkdir(workRunsRoot, { recursive: true, mode: 0o700 });
await mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
await recoverBenchmarkPublications({ runsRoot, workRunsRoot, quarantineRoot });
await mkdir(runRoot, { mode: 0o700 });
let publicationComplete = false;
process.once("exit", () => {
  if (!publicationComplete) {
    rmSync(runRoot, { recursive: true, force: true });
    rmSync(publishedRunRoot, { recursive: true, force: true });
  }
});
const nodeCacheRoot = join(
  projectRoot,
  "output",
  "benchmarks",
  "terminal-bench-2.1",
  "cache",
  "node",
);
const nodeArchivePaths = {
  x64: await ensurePinnedDownload(nodeArchives.x64, nodeCacheRoot),
  arm64: await ensurePinnedDownload(nodeArchives.arm64, nodeCacheRoot),
};
const harborWheelPath = await ensurePinnedArtifact(
  {
    name: "harbor-0.20.0-py3-none-any.whl",
    sha256: harborWheelSha256,
    urls: [harborWheelUrl],
  },
  join(projectRoot, "output", "benchmarks", "terminal-bench-2.1", "cache", "harbor"),
);
await run("npm", ["run", "build"], projectRoot, process.env);
const bundle = await buildPicoBundle(join(runRoot, "pico-bundle.tar.gz"));
const routeConfig = {
  schemaVersion: 1,
  modelRouteId,
  providerId,
  provider,
  ...(options.thinkingEffort
    ? { thinkingEffort: options.thinkingEffort }
    : userConfig.defaults?.thinkingEffort
      ? { thinkingEffort: userConfig.defaults.thinkingEffort }
      : {}),
};
const routeConfigPath = join(runRoot, "route-config.json");
await atomicWritePrivateJson(routeConfigPath, routeConfig);
const gatewayCapabilitySeed = randomBytes(32).toString("hex");
const gatewaySupervisor = await startGatewaySupervisor({
  routeConfigPath,
  providerSecret,
  runId,
  capabilitySeed: gatewayCapabilitySeed,
  env: allowlistedHostEnv(process.env),
});
const tasks = await resolveTasks(mode, options.task);
const scheduledTasks = tasks.length;
const expectedTrials = scheduledTasks * options.attempts;
const localDatasetPath = mode === "full" ? null : await prepareLocalDataset(tasks, runRoot);
const canaryHash = createHash("sha256").update(tasks.join("\n")).digest("hex");
const taskLockPath = join(projectRoot, "benchmarks/terminal_bench_2_1/canary-task-lock.json");
const manifest = {
  schemaVersion: 1,
  runId,
  startedAt: new Date().toISOString(),
  pico: {
    commit: picoCommit,
    bundleSha256: bundle.sha256,
    bundleLockfileSha256: bundle.lockfileSha256,
    dirty: false,
  },
  harbor: {
    version: harborVersion,
    commit: harborCommit,
    wheelSha256: harborWheelSha256,
    constraintsSha256: createHash("sha256")
      .update(
        await readFile(join(projectRoot, "benchmarks/terminal_bench_2_1/harbor-constraints.txt")),
      )
      .digest("hex"),
    offline: true,
  },
  dataset: {
    id: datasetRef,
    sourceCommit: datasetSourceCommit,
    taskCount: scheduledTasks,
    taskListSha256: canaryHash,
    localTaskLockSha256:
      localDatasetPath === null
        ? null
        : createHash("sha256")
            .update(await readFile(taskLockPath))
            .digest("hex"),
  },
  nodeRuntime: {
    version: "22.14.0",
    sources: ["https://nodejs.org/dist/v22.14.0/", "https://npmmirror.com/mirrors/node/v22.14.0/"],
    archives: {
      linuxX64: "9d942932535988091034dc94cc5f42b6dc8784d6366df3a36c4c9ccb3996f0c2",
      linuxArm64: "8cf30ff7250f9463b53c18f89c6c606dfda70378215b2c905d0a9a8b08bd45e0",
    },
  },
  model: {
    modelRouteId,
    protocol: provider.protocol ?? "openai",
    baseURL: redactUrl(provider.baseURL),
    endpointRewritten: false,
    thinkingEffort: routeConfig.thinkingEffort ?? null,
    apiKeyEnv: benchmarkApiKeyEnv,
  },
  policy: {
    permissionMode: "yolo",
    allowedTools: ["bash", "read_file", "write_file", "edit_file", "glob", "grep", "read_evidence"],
    localCanaryOnly: true,
    leaderboardComparable: false,
    secretInjection: "host-credential-gateway",
    dockerDelete: true,
    keepContainers: false,
    providerBudget: {
      maxCalls: 128,
      maxInputTokenUpperBound: 1_000_000,
      maxOutputTokens: 65_536,
      maxCostCNYAtWorstCaseRate: 250,
      maxConcurrentRequests: 1,
    },
  },
  execution: {
    mode,
    attempts: options.attempts,
    concurrency: options.concurrency,
    os: process.platform,
    arch: process.arch,
    hostNode: process.version,
  },
};
await atomicWritePrivateJson(join(runRoot, "manifest.json"), manifest);

const harborArgs = [
  "--offline",
  "--no-env-file",
  "--no-config",
  "--no-python-downloads",
  "--constraints",
  join(projectRoot, "benchmarks/terminal_bench_2_1/harbor-constraints.txt"),
  "--from",
  harborWheelPath,
  "harbor",
  "run",
  "--env",
  "docker",
  "--delete",
  "--agent",
  "benchmarks.terminal_bench_2_1.pico_agent:PicoInstalledAgent",
  "--model",
  modelRouteId,
  "--ak",
  `bundle_path=${bundle.path}`,
  "--ak",
  `bundle_sha256=${bundle.sha256}`,
  "--ak",
  `bundle_lockfile_sha256=${bundle.lockfileSha256}`,
  "--ak",
  `route_config_path=${routeConfigPath}`,
  "--ak",
  `node_x64_path=${nodeArchivePaths.x64}`,
  "--ak",
  `node_arm64_path=${nodeArchivePaths.arm64}`,
  "--ak",
  `pico_commit=${picoCommit}`,
  "--n-attempts",
  String(options.attempts),
  "--n-concurrent",
  String(options.concurrency),
  "--jobs-dir",
  join(runRoot, "harbor-job"),
  "--job-name",
  "job",
  "--yes",
  "--max-retries",
  "2",
  "--retry-include",
  "RuntimeError",
];
if (localDatasetPath === null) harborArgs.push("--dataset", datasetRef);
else harborArgs.push("--path", localDatasetPath);
const dockerContainersBefore = await captureDockerContainerIds(harborEnv);
let harborExecution;
try {
  harborExecution = await runCaptured(
    "uvx",
    harborArgs,
    runRoot,
    harborEnv,
    JSON.stringify({
      socketPath: gatewaySupervisor.socketPath,
      capabilitySeed: gatewayCapabilitySeed,
      runId,
    }),
  );
} finally {
  await gatewaySupervisor.stop();
}
const harborExitCode = harborExecution.exitCode;
await atomicWritePrivateText(
  join(runRoot, "harbor-stdout.log"),
  redactSecrets(harborExecution.stdout, [providerSecret]),
);
await atomicWritePrivateText(
  join(runRoot, "harbor-stderr.log"),
  redactSecrets(harborExecution.stderr, [providerSecret]),
);
await cleanupDockerNetworks(harborEnv, runId);
const dockerContainersAfter = await captureDockerContainerIds(harborEnv);
const addedDockerContainers = [...dockerContainersAfter].filter(
  (containerId) => !dockerContainersBefore.has(containerId),
);
if (addedDockerContainers.length > 0) {
  throw new Error("Harbor left benchmark containers behind after --delete");
}
await rewriteTextPaths(runRoot, runRoot, publishedRunRoot);
const summary = await normalizeHarborJob({
  jobDir: join(runRoot, "harbor-job", "job"),
  runDir: runRoot,
  runId,
  expectedTasks: expectedTrials,
  expectedTaskNames: tasks,
  expectedAttempts: options.attempts,
});
await atomicWritePrivateJson(join(runRoot, "run-status.json"), {
  schemaVersion: 1,
  harborExitCode,
  normalized: true,
  secretScan: { status: "required-before-publish" },
  completedAt: new Date().toISOString(),
});
const gatewayCapabilities = summary.trials
  .map((trial) => trial.trialId)
  .filter((trialId) => typeof trialId === "string")
  .map((trialId) =>
    createHmac("sha256", gatewayCapabilitySeed)
      .update(`pico-terminal-bench:${trialId}`)
      .digest("hex"),
  );
const gateFailed = summary.trials.some(
  (trial) =>
    trial.infra.status !== "ok" ||
    trial.adapter.status !== "ok" ||
    trial.verifier.status !== "completed",
);
if (harborExitCode !== 0 || gateFailed || !summary.sealed) {
  throw new Error("Terminal-Bench run did not satisfy the publication gate");
}
try {
  const prePublishScan = await scanTreeForSecrets(runRoot, [
    providerSecret,
    gatewayCapabilitySeed,
    ...gatewayCapabilities,
  ]);
  if (prePublishScan.matches.length > 0) {
    throw new Error("Secret canary scan failed");
  }
  const prePublishTreeSha256 = await hashDirectory(runRoot);
  await atomicWritePrivateJson(join(runRoot, "PUBLISHED.json"), {
    schemaVersion: 1,
    runId,
    sealed: true,
    secretScan: {
      status: "passed",
      filesScanned: prePublishScan.filesScanned,
      bytesScanned: prePublishScan.bytesScanned,
    },
    fullTreeExcludingMarkerSha256: prePublishTreeSha256,
    containerDeleteProof: { addedContainerIds: [] },
    summarySha256: createHash("sha256")
      .update(await readFile(join(runRoot, "summary.json")))
      .digest("hex"),
    sourceHashesSha256: createHash("sha256")
      .update(await readFile(join(runRoot, "source-hashes.json")))
      .digest("hex"),
  });
  const finalScan = await scanTreeForSecrets(runRoot, [
    providerSecret,
    gatewayCapabilitySeed,
    ...gatewayCapabilities,
  ]);
  const finalTreeSha256 = await hashDirectory(runRoot, new Set(["PUBLISHED.json"]));
  if (finalScan.matches.length > 0 || finalTreeSha256 !== prePublishTreeSha256) {
    throw new Error("Final benchmark publication verification failed");
  }
  await fsyncTree(runRoot);
  await rename(runRoot, publishedRunRoot);
  await fsyncDirectory(runsRoot);
  await fsyncDirectory(workRunsRoot);
  const publishedTreeSha256 = await hashDirectory(publishedRunRoot, new Set(["PUBLISHED.json"]));
  if (publishedTreeSha256 !== prePublishTreeSha256) {
    throw new Error("Atomic benchmark publication changed the result tree");
  }
  await fsyncDirectory(runsRoot);
} catch (error) {
  await rm(runRoot, { recursive: true, force: true });
  await rm(publishedRunRoot, { recursive: true, force: true });
  throw error;
}
publicationComplete = true;
process.stdout.write(
  `${JSON.stringify({ runId, runRoot: publishedRunRoot, harborExitCode, summary }, null, 2)}\n`,
);

function parseArgs(args) {
  const parsed = { mode: "canary", attempts: 1, concurrency: 1, dockerHostGateway: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--docker-host-gateway") parsed.dockerHostGateway = true;
    else if (arg === "--mode") parsed.mode = requiredValue(args, ++index, arg);
    else if (arg === "--task") parsed.task = requiredValue(args, ++index, arg);
    else if (arg === "--config") parsed.config = requiredValue(args, ++index, arg);
    else if (arg === "--env-file") parsed.envFile = requiredValue(args, ++index, arg);
    else if (arg === "--model-route-id") parsed.modelRouteId = requiredValue(args, ++index, arg);
    else if (arg === "--thinking-effort") parsed.thinkingEffort = requiredValue(args, ++index, arg);
    else if (arg === "--attempts")
      parsed.attempts = positiveInteger(requiredValue(args, ++index, arg), arg);
    else if (arg === "--concurrency")
      parsed.concurrency = positiveInteger(requiredValue(args, ++index, arg), arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["single", "canary", "full"].includes(parsed.mode)) {
    throw new Error("--mode must be single, canary, or full");
  }
  return parsed;
}

async function resolveTasks(mode, singleTask) {
  if (mode === "single") {
    if (!singleTask?.startsWith("terminal-bench/")) {
      throw new Error("--task must use terminal-bench/<name>");
    }
    return [singleTask];
  }
  const raw = await readFile(
    join(
      projectRoot,
      mode === "full"
        ? "benchmarks/terminal_bench_2_1/full-task-names.txt"
        : "benchmarks/terminal_bench_2_1/canary-task-names.txt",
    ),
    "utf8",
  );
  const names = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (new Set(names).size !== names.length) {
    throw new Error(`Terminal-Bench ${mode} task list contains duplicates`);
  }
  if (mode === "full" && names.length !== 89) {
    throw new Error(`Terminal-Bench full task list must contain exactly 89 tasks`);
  }
  return names;
}

async function prepareLocalDataset(tasks, runRoot) {
  const lockPath = join(projectRoot, "benchmarks/terminal_bench_2_1/canary-task-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  if (lock.schemaVersion !== 1 || typeof lock.tasks !== "object") {
    throw new Error("Terminal-Bench canary task lock is invalid");
  }
  const destination = join(runRoot, "local-dataset");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const taskName of tasks) {
    const expected = lock.tasks[taskName];
    if (
      !expected ||
      !/^[0-9a-f]{64}$/u.test(expected.cacheDigest) ||
      !/^[0-9a-f]{64}$/u.test(expected.treeSha256)
    ) {
      throw new Error(`Terminal-Bench task is absent from the local lock: ${taskName}`);
    }
    const shortName = taskName.replace(/^terminal-bench\//u, "");
    const source = join(
      homedir(),
      ".cache/harbor/tasks/packages/terminal-bench",
      shortName,
      expected.cacheDigest,
    );
    if ((await hashDirectory(source)) !== expected.treeSha256) {
      throw new Error(`Terminal-Bench cached task digest mismatch: ${taskName}`);
    }
    const taskDestination = join(destination, shortName);
    await cp(source, taskDestination, { recursive: true, errorOnExist: true });
    if ((await hashDirectory(taskDestination)) !== expected.treeSha256) {
      throw new Error(`Terminal-Bench staged task digest mismatch: ${taskName}`);
    }
    await assertTaskComposePolicy(taskDestination, allowlistedHostEnv(process.env));
  }
  return destination;
}

async function hashDirectory(root, ignored = new Set()) {
  const hash = createHash("sha256");
  async function visit(path, relative) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Pinned task contains a symlink: ${path}`);
    if (info.isDirectory()) {
      const entries = (await readdir(path, { withFileTypes: true })).sort((left, right) =>
        left.name.localeCompare(right.name),
      );
      for (const entry of entries) {
        const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (!ignored.has(entryRelative)) await visit(join(path, entry.name), entryRelative);
      }
      return;
    }
    if (!info.isFile()) return;
    const data = await readFile(path);
    hash.update(`${relative}\0${data.length}\0`);
    hash.update(data);
  }
  await visit(root, "");
  return hash.digest("hex");
}

async function recoverBenchmarkPublications({ runsRoot, workRunsRoot, quarantineRoot }) {
  for (const entry of await readdir(workRunsRoot, { withFileTypes: true })) {
    const path = join(workRunsRoot, entry.name);
    await quarantine(path, quarantineRoot, "staging");
  }
  for (const entry of await readdir(runsRoot, { withFileTypes: true })) {
    const path = join(runsRoot, entry.name);
    try {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error("published benchmark entry is not a directory");
      }
      const marker = JSON.parse(await readFile(join(path, "PUBLISHED.json"), "utf8"));
      const summary = JSON.parse(await readFile(join(path, "summary.json"), "utf8"));
      const status = JSON.parse(await readFile(join(path, "run-status.json"), "utf8"));
      if (
        marker.schemaVersion !== 1 ||
        marker.runId !== entry.name ||
        (marker.sealed !== undefined && marker.sealed !== true) ||
        summary.runId !== entry.name ||
        summary.sealed !== true ||
        status.harborExitCode !== 0 ||
        !/^[0-9a-f]{64}$/u.test(marker.fullTreeExcludingMarkerSha256)
      ) {
        throw new Error("published benchmark marker is invalid");
      }
      const treeHash = await hashDirectory(path, new Set(["PUBLISHED.json"]));
      if (treeHash !== marker.fullTreeExcludingMarkerSha256) {
        throw new Error("published benchmark tree hash is invalid");
      }
    } catch {
      await quarantine(path, quarantineRoot, "invalid-published");
    }
  }
}

async function rewriteTextPaths(root, from, to) {
  const extensions = new Set([".json", ".jsonl", ".log", ".md", ".txt", ".toml", ".yaml", ".yml"]);
  const replacements = [
    [from, to],
    [encodeURI(from), encodeURI(to)],
  ];
  async function visit(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Result tree contains symlink: ${path}`);
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) await visit(join(path, entry));
      return;
    }
    if (!info.isFile() || ![...extensions].some((extension) => path.endsWith(extension))) return;
    const value = await readFile(path, "utf8");
    const rewritten = replacements.reduce(
      (current, [source, destination]) => current.replaceAll(source, destination),
      value,
    );
    if (rewritten !== value) await atomicWritePrivateText(path, rewritten);
  }
  await visit(root);
}

async function quarantine(path, root, reason) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  await rename(
    path,
    join(root, `${reason}-${name}-${Date.now()}-${randomBytes(4).toString("hex")}`),
  );
  await fsyncDirectory(root);
}

async function fsyncTree(root) {
  async function visit(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Result tree contains symlink: ${path}`);
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) await visit(join(path, entry));
      await fsyncDirectory(path);
      return;
    }
    if (!info.isFile()) return;
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await visit(root);
}

async function fsyncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function assertLoopbackAllowed(baseURL, enabled) {
  const url = new URL(baseURL);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Provider URL must not contain userinfo, query, or fragment");
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (!loopback) return;
  if (!enabled) throw new Error("Loopback provider requires explicit --docker-host-gateway");
}

function redactUrl(value) {
  const url = new URL(value);
  return `${url.protocol}//${url.host}`;
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

async function atomicWritePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function atomicWritePrivateText(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function ensurePinnedDownload(archive, cacheRoot) {
  return ensurePinnedArtifact(
    {
      ...archive,
      urls: [
        `https://nodejs.org/dist/v22.14.0/${archive.name}`,
        `https://npmmirror.com/mirrors/node/v22.14.0/${archive.name}`,
      ],
    },
    cacheRoot,
  );
}

async function ensurePinnedArtifact(artifact, cacheRoot) {
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const destination = join(cacheRoot, artifact.name);
  try {
    if (
      createHash("sha256")
        .update(await readFile(destination))
        .digest("hex") === artifact.sha256
    ) {
      return destination;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let lastError;
  for (const url of artifact.urls) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Pinned artifact download returned ${response.status}`);
        const data = Buffer.from(await response.arrayBuffer());
        const digest = createHash("sha256").update(data).digest("hex");
        if (digest !== artifact.sha256) throw new Error("Pinned artifact digest mismatch");
        const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(data);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, destination);
        return destination;
      } catch (error) {
        lastError = error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 1_000));
      }
    }
  }
  throw lastError;
}

async function scanTreeForSecrets(root, secrets) {
  const encoded = secrets.flatMap((secret) => [
    ["raw", Buffer.from(secret)],
    ["json", Buffer.from(JSON.stringify(secret).slice(1, -1))],
    ["url", Buffer.from(encodeURIComponent(secret))],
    ["base64", Buffer.from(Buffer.from(secret).toString("base64"))],
    ["base64url", Buffer.from(Buffer.from(secret).toString("base64url"))],
    ["hex", Buffer.from(Buffer.from(secret).toString("hex"))],
    ["utf16le", Buffer.from(secret, "utf16le")],
    ["utf16be", Buffer.from(secret, "utf16le").swap16()],
  ]);
  const matches = [];
  let filesScanned = 0;
  let bytesScanned = 0;
  let expandedBytesScanned = 0;
  const maxExpandedBytes = 4 * 1024 * 1024 * 1024;
  function scanCandidate(path, containerEncoding, candidate, depth = 0) {
    if (depth > 8) throw new Error("Result archive nesting exceeds the secret scan limit");
    expandedBytesScanned += candidate.length;
    if (expandedBytesScanned > maxExpandedBytes) {
      throw new Error("Result archive expansion exceeds the secret scan byte budget");
    }
    for (const [encoding, needle] of encoded) {
      if (needle.length > 0 && candidate.includes(needle)) {
        matches.push({
          path: path.slice(root.length + 1),
          encoding: `${containerEncoding}:${encoding}`,
        });
      }
    }
    if (candidate.length >= 2 && candidate[0] === 0x1f && candidate[1] === 0x8b) {
      scanCandidate(
        path,
        `${containerEncoding}>gzip`,
        gunzipSync(candidate, { maxOutputLength: 512 * 1024 * 1024 }),
        depth + 1,
      );
      return;
    }
    if (candidate.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      scanZip(path, containerEncoding, candidate, depth);
      return;
    }
    if (
      candidate.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) ||
      candidate.subarray(0, 3).equals(Buffer.from("BZh")) ||
      candidate.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) ||
      candidate.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
    ) {
      throw new Error("Result tree contains an unsupported compressed archive");
    }
    if (candidate.length >= 512 && candidate.subarray(257, 262).toString("ascii") === "ustar") {
      for (let offset = 0; offset + 512 <= candidate.length; ) {
        const header = candidate.subarray(offset, offset + 512);
        if (header.every((byte) => byte === 0)) break;
        const type = String.fromCharCode(header[156] || 0x30);
        if (["1", "2"].includes(type)) {
          throw new Error("Result archive contains a link entry");
        }
        const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim();
        const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
        if (!Number.isSafeInteger(size) || size < 0) {
          throw new Error("Result archive contains an invalid entry size");
        }
        const bodyStart = offset + 512;
        const bodyEnd = bodyStart + size;
        if (bodyEnd > candidate.length) {
          throw new Error("Result archive is truncated");
        }
        if (type === "0" || type === "\0") {
          scanCandidate(
            path,
            `${containerEncoding}>tar`,
            candidate.subarray(bodyStart, bodyEnd),
            depth + 1,
          );
        }
        offset = bodyStart + Math.ceil(size / 512) * 512;
      }
    }
  }
  function scanZip(path, containerEncoding, candidate, depth) {
    const minimum = Math.max(0, candidate.length - 65_557);
    let eocd = -1;
    for (let offset = candidate.length - 22; offset >= minimum; offset -= 1) {
      if (candidate.readUInt32LE(offset) === 0x06054b50) {
        eocd = offset;
        break;
      }
    }
    if (eocd < 0) throw new Error("Result ZIP archive has no central directory");
    const entries = candidate.readUInt16LE(eocd + 10);
    const centralSize = candidate.readUInt32LE(eocd + 12);
    const centralOffset = candidate.readUInt32LE(eocd + 16);
    if (centralOffset + centralSize > candidate.length || entries > 100_000) {
      throw new Error("Result ZIP archive exceeds the scan limit");
    }
    let offset = centralOffset;
    for (let index = 0; index < entries; index += 1) {
      if (candidate.readUInt32LE(offset) !== 0x02014b50) {
        throw new Error("Result ZIP central directory is invalid");
      }
      const flags = candidate.readUInt16LE(offset + 8);
      const method = candidate.readUInt16LE(offset + 10);
      const compressedSize = candidate.readUInt32LE(offset + 20);
      const uncompressedSize = candidate.readUInt32LE(offset + 24);
      const nameLength = candidate.readUInt16LE(offset + 28);
      const extraLength = candidate.readUInt16LE(offset + 30);
      const commentLength = candidate.readUInt16LE(offset + 32);
      const externalAttributes = candidate.readUInt32LE(offset + 38);
      const localOffset = candidate.readUInt32LE(offset + 42);
      const unixMode = externalAttributes >>> 16;
      if ((flags & 1) !== 0 || (unixMode & 0o170000) === 0o120000) {
        throw new Error("Result ZIP archive contains an encrypted or linked entry");
      }
      if (candidate.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error("Result ZIP local header is invalid");
      }
      const localNameLength = candidate.readUInt16LE(localOffset + 26);
      const localExtraLength = candidate.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > candidate.length || uncompressedSize > 512 * 1024 * 1024) {
        throw new Error("Result ZIP entry exceeds the scan limit");
      }
      const compressed = candidate.subarray(dataStart, dataEnd);
      const expanded =
        method === 0
          ? compressed
          : method === 8
            ? inflateRawSync(compressed, { maxOutputLength: 512 * 1024 * 1024 })
            : null;
      if (expanded === null || expanded.length !== uncompressedSize) {
        throw new Error("Result ZIP entry uses an unsupported encoding");
      }
      scanCandidate(path, `${containerEncoding}>zip`, expanded, depth + 1);
      offset += 46 + nameLength + extraLength + commentLength;
    }
    if (offset !== centralOffset + centralSize) {
      throw new Error("Result ZIP central directory length is invalid");
    }
  }
  async function visit(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Result tree contains symlink: ${path}`);
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) await visit(join(path, entry));
      return;
    }
    if (!info.isFile()) return;
    filesScanned += 1;
    if (filesScanned > 100_000 || info.size > 64 * 1024 * 1024) {
      throw new Error("Result tree exceeds the secret scan resource limit");
    }
    bytesScanned += info.size;
    if (bytesScanned > 4 * 1024 * 1024 * 1024) {
      throw new Error("Result tree exceeds the secret scan byte budget");
    }
    const data = await readFile(path);
    scanCandidate(path, "file", data);
  }
  await visit(root);
  return { matches, filesScanned, bytesScanned };
}

function run(command, args, cwd, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else {
        const error = new Error(`${command} exited with ${code}`);
        error.exitCode = code ?? 1;
        reject(error);
      }
    });
  });
}

async function startGatewaySupervisor({
  routeConfigPath,
  providerSecret,
  runId,
  capabilitySeed,
  env,
}) {
  const directory = await mkdtemp(join(tmpdir(), "pico-tb-gateway-"));
  const socketPath = join(directory, "gateway.sock");
  const child = spawn(
    "python3",
    [
      join(projectRoot, "benchmarks/terminal_bench_2_1/gateway_supervisor.py"),
      "--socket",
      socketPath,
      "--route-config",
      routeConfigPath,
    ],
    {
      cwd: directory,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.end(JSON.stringify({ providerSecret, runId, capabilitySeed }));
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > 1024 * 1024) child.kill("SIGKILL");
  });
  await new Promise((resolvePromise, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Gateway supervisor readiness timed out"));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("READY\n")) {
        clearTimeout(timeout);
        resolvePromise();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Gateway supervisor exited with ${code}: ${stderr}`));
    });
  });
  return {
    socketPath,
    async stop() {
      if (child.exitCode === null) child.kill("SIGTERM");
      await new Promise((resolvePromise) => {
        if (child.exitCode !== null) resolvePromise();
        else child.once("exit", resolvePromise);
      });
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function runCaptured(command, args, cwd, env, supervisorConfig) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    child.stdio[3].end(supervisorConfig);
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) {
        child.kill("SIGKILL");
        reject(new Error(`${command} output exceeded the benchmark capture limit`));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", reject);
    child.once("exit", (code) => {
      resolvePromise({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function redactSecrets(value, secrets) {
  let redacted = value;
  for (const secret of secrets.filter(Boolean).sort((left, right) => right.length - left.length)) {
    for (const candidate of [
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
      Buffer.from(secret).toString("base64"),
    ]) {
      redacted = redacted.split(candidate).join("[REDACTED]");
    }
  }
  return redacted;
}

function capture(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise(output);
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

async function captureDockerContainerIds(env) {
  const output = await captureWithEnv("docker", ["ps", "-aq", "--no-trunc"], projectRoot, env);
  return new Set(
    output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => /^[0-9a-f]{64}$/u.test(line)),
  );
}

async function cleanupDockerNetworks(env, runId) {
  const output = await captureWithEnv(
    "docker",
    ["network", "ls", "--quiet", "--filter", `label=pico.terminal-bench.run=${runId}`],
    projectRoot,
    env,
  );
  const networkIds = output
    .split(/\s+/u)
    .map((value) => value.trim())
    .filter(Boolean);
  for (const networkId of networkIds) {
    await run("docker", ["network", "rm", networkId], projectRoot, env);
  }
}

function captureWithEnv(command, args, cwd, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${command} exited with ${code}: ${stderr}`));
    });
  });
}

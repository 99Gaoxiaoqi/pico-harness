import { createHash, createHmac, randomBytes } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { buildPicoBundle } from "./build-bundle.mjs";
import { allowlistedHostEnv, openUnlinkedSecret } from "./host-secret-boundary.mjs";
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
const runsRoot = join(projectRoot, "output", "benchmarks", "terminal-bench-2.1", "runs");
const runRoot = join(runsRoot, runId);
await mkdir(runsRoot, { recursive: true, mode: 0o700 });
await mkdir(runRoot, { mode: 0o700 });
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
const gatewaySupervisor = await startGatewaySupervisor({
  routeConfigPath,
  providerSecret,
  env: allowlistedHostEnv(process.env),
});
const gatewayCapabilitySeed = randomBytes(32).toString("hex");
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
  harbor: { version: harborVersion, commit: harborCommit, wheelSha256: harborWheelSha256 },
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
const supervisorSocketHandle = await openUnlinkedSecret(
  JSON.stringify({
    socketPath: gatewaySupervisor.socketPath,
    capabilitySeed: gatewayCapabilitySeed,
  }),
  runRoot,
);
let harborExecution;
try {
  harborExecution = await runCaptured(
    "uvx",
    harborArgs,
    runRoot,
    harborEnv,
    supervisorSocketHandle.fd,
  );
} finally {
  await supervisorSocketHandle.close();
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
const dockerContainersAfter = await captureDockerContainerIds(harborEnv);
const addedDockerContainers = [...dockerContainersAfter].filter(
  (containerId) => !dockerContainersBefore.has(containerId),
);
if (addedDockerContainers.length > 0) {
  throw new Error("Harbor left benchmark containers behind after --delete");
}
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
try {
  const prePublishScan = await scanTreeForSecrets(runRoot, [
    providerSecret,
    ...gatewayCapabilities,
  ]);
  if (prePublishScan.matches.length > 0) {
    throw new Error("Secret canary scan failed");
  }
  const prePublishTreeSha256 = await hashDirectory(runRoot);
  await atomicWritePrivateJson(join(runRoot, "PUBLISHED.json"), {
    schemaVersion: 1,
    runId,
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
  const finalScan = await scanTreeForSecrets(runRoot, [providerSecret, ...gatewayCapabilities]);
  const finalTreeSha256 = await hashDirectory(runRoot, new Set(["PUBLISHED.json"]));
  if (finalScan.matches.length > 0 || finalTreeSha256 !== prePublishTreeSha256) {
    throw new Error("Final benchmark publication verification failed");
  }
} catch (error) {
  await rm(runRoot, { recursive: true, force: true });
  throw error;
}
process.stdout.write(`${JSON.stringify({ runId, runRoot, harborExitCode, summary }, null, 2)}\n`);
const gateFailed = summary.trials.some(
  (trial) =>
    trial.infra.status !== "ok" ||
    trial.adapter.status !== "ok" ||
    trial.verifier.status !== "completed",
);
if (harborExitCode !== 0 || gateFailed || !summary.sealed) process.exitCode = harborExitCode || 1;

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
    const candidates = [["file", data]];
    if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
      candidates.push(["gzip", gunzipSync(data, { maxOutputLength: 64 * 1024 * 1024 })]);
    }
    for (const [containerEncoding, candidate] of candidates) {
      for (const [encoding, needle] of encoded) {
        if (needle.length > 0 && candidate.includes(needle)) {
          matches.push({
            path: path.slice(root.length + 1),
            encoding: `${containerEncoding}:${encoding}`,
          });
        }
      }
    }
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

async function startGatewaySupervisor({ routeConfigPath, providerSecret, env }) {
  const directory = await mkdtemp(join(tmpdir(), "pico-tb-gateway-"));
  const socketPath = join(directory, "gateway.sock");
  const secretHandle = await openUnlinkedSecret(providerSecret, directory);
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
      stdio: ["ignore", "pipe", "pipe", "ignore", secretHandle.fd],
    },
  );
  await secretHandle.close();
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

function runCaptured(command, args, cwd, env, secretFd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe", secretFd],
    });
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

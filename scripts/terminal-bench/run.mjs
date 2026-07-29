import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { rmSync } from "node:fs";
import { acquireBenchmarkLock } from "./benchmark-lock.mjs";
import { buildPicoBundle } from "./build-bundle.mjs";
import { runCaptured } from "./captured-process.mjs";
import { assertTaskComposePolicy, prestartNetworkOverlay } from "./container-policy.mjs";
import { captureDockerResourceSnapshot, cleanupDockerResources } from "./docker-resources.mjs";
import { verifyApprovedHarborWheelhouse } from "./harbor-wheelhouse.mjs";
import { allowlistedHostEnv } from "./host-secret-boundary.mjs";
import { normalizeHarborJob } from "./normalize-results.mjs";
import {
  fsyncDirectory,
  fsyncTree,
  hashDirectory,
  recoverBenchmarkPublications,
} from "./publication.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const datasetRef =
  "terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a";
const datasetSourceCommit = "5c8eadf1f393183288fa08b8f73ca9a469cc5e00";
const harborVersion = "0.20.0";
const harborCommit = "459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc";
const harborWheelSha256 = "4b7e48223aea2384cdb8c9eff35eaebd482fc9b1ec09f8193a121c47356ff19a";
const harborArtifactManifestSha256 =
  "2a1ee868d8f3b488d49bf08aa405d81cc19a044317335fd3ef0ac12368068cd6";
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

if (process.env.PICO_TB_SECRET_SCAN_ROOT && process.env.PICO_TB_SECRET_SCAN_CANARY) {
  const result = await scanTreeForSecrets(process.env.PICO_TB_SECRET_SCAN_ROOT, [
    process.env.PICO_TB_SECRET_SCAN_CANARY,
  ]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

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
const pricing = {
  schemaVersion: 1,
  providerId,
  model,
  currency: "CNY",
  unit: "microCNYPerMillionTokens",
  input: 100_000_000,
  output: 1_000_000_000,
};
const pricingSha256 = createHash("sha256")
  .update(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(pricing).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      ),
    ),
  )
  .digest("hex");
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
if (mode === "full") {
  throw new Error("Full Terminal-Bench runs are disabled until dataset preflight is materialized");
}
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
const benchmarkLock = await acquireBenchmarkLock(benchmarkRoot);
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
await ensurePinnedArtifact(
  {
    name: "harbor-0.20.0-py3-none-any.whl",
    sha256: harborWheelSha256,
    urls: [harborWheelUrl],
  },
  join(projectRoot, "output", "benchmarks", "terminal-bench-2.1", "cache", "harbor"),
);
const harborConstraintsPath = join(
  projectRoot,
  "benchmarks/terminal_bench_2_1/harbor-constraints.txt",
);
const harborWheelhousePath = join(
  projectRoot,
  "output/benchmarks/terminal-bench-2.1/cache/harbor-wheelhouse",
);
const harborArtifactLock = await verifyApprovedHarborWheelhouse({
  manifestPath: join(harborWheelhousePath, "artifact-manifest.json"),
  wheelhousePath: harborWheelhousePath,
  constraintsPath: harborConstraintsPath,
  expectedManifestSha256: harborArtifactManifestSha256,
});
await run("npm", ["run", "build"], projectRoot, process.env);
const bundle = await buildPicoBundle(join(runRoot, "pico-bundle.tar.gz"));
const routeConfig = {
  schemaVersion: 1,
  modelRouteId,
  providerId,
  provider,
  pricing,
  pricingSha256,
  ...(options.thinkingEffort
    ? { thinkingEffort: options.thinkingEffort }
    : userConfig.defaults?.thinkingEffort
      ? { thinkingEffort: userConfig.defaults.thinkingEffort }
      : {}),
};
const routeConfigPath = join(runRoot, "route-config.json");
const dockerOwnershipRegistryPath = join(runRoot, "docker-ownership.jsonl");
await atomicWritePrivateJson(routeConfigPath, routeConfig);
const gatewayCapabilitySeed = randomBytes(32).toString("hex");
const gatewaySupervisor = await startGatewaySupervisor({
  routeConfigPath,
  providerSecret,
  runId,
  capabilitySeed: gatewayCapabilitySeed,
  env: allowlistedHostEnv(process.env),
});
process.once("exit", () => gatewaySupervisor.stopSync());
const tasks = await resolveTasks(mode, options.task);
const scheduledTasks = tasks.length;
const expectedTrials = scheduledTasks * options.attempts;
const localDatasetSourcePath =
  mode === "full" ? null : await prepareLocalDataset(tasks, runRoot, runId);
const localDatasetTreeSha256 =
  localDatasetSourcePath === null ? null : await hashDirectory(localDatasetSourcePath);
const localDatasetSnapshot =
  localDatasetSourcePath === null
    ? null
    : await materializeReadOnlyDatasetSnapshot(localDatasetSourcePath, runRoot);
const localDatasetPath = localDatasetSnapshot?.mountPath ?? null;
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
      .update(await readFile(harborConstraintsPath))
      .digest("hex"),
    artifactManifestSha256: harborArtifactLock.manifestSha256,
    artifactCount: harborArtifactLock.artifactCount,
    artifactPlatform: harborArtifactLock.platform,
    offline: true,
  },
  dataset: {
    id: datasetRef,
    sourceCommit: datasetSourceCommit,
    taskCount: scheduledTasks,
    taskListSha256: canaryHash,
    localTaskLockSha256:
      localDatasetSourcePath === null
        ? null
        : createHash("sha256")
            .update(await readFile(taskLockPath))
            .digest("hex"),
    localDatasetTreeSha256,
    localDatasetImageSha256: localDatasetSnapshot?.imageSha256 ?? null,
    executionSnapshot: localDatasetSnapshot === null ? null : "read-only-udro",
  },
  nodeRuntime: {
    version: "22.14.0",
    sources: ["https://nodejs.org/dist/v22.14.0/", "https://npmmirror.com/mirrors/node/v22.14.0/"],
    archives: {
      linuxX64: "9d942932535988091034dc94cc5f42b6dc8784d6366df3a36c4c9ccb3996f0c2",
      linuxArm64: "8cf30ff7250f9463b53c18f89c6c606dfda70378215b2c905d0a9a8b08bd45e0",
    },
    relayImageId: "sha256:5647be709086c696ff32edaaf1c70cd26d1da6ab2b39c32f3c7b4c4a31957e37",
  },
  model: {
    modelRouteId,
    protocol: provider.protocol ?? "openai",
    baseURL: redactUrl(provider.baseURL),
    endpointRewritten: false,
    thinkingEffort: routeConfig.thinkingEffort ?? null,
    apiKeyEnv: benchmarkApiKeyEnv,
    pricing,
    pricingSha256,
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
      lockedPricingSha256: pricingSha256,
      lockedRateMaximumCostCNY: 165.536,
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

const harborVirtualEnvironment = join(runRoot, "harbor-venv");
await run(
  "uv",
  [
    "venv",
    "--offline",
    "--no-config",
    "--python",
    harborArtifactLock.python,
    harborVirtualEnvironment,
  ],
  projectRoot,
  harborEnv,
);
await run(
  "uv",
  [
    "pip",
    "install",
    "--python",
    join(harborVirtualEnvironment, "bin/python"),
    "--offline",
    "--no-config",
    "--no-cache",
    "--no-index",
    "--find-links",
    harborWheelhousePath,
    "--constraint",
    harborConstraintsPath,
    `harbor==${harborVersion}`,
  ],
  projectRoot,
  harborEnv,
);
const harborArgs = [
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
  `resource_registry_path=${dockerOwnershipRegistryPath}`,
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
else harborArgs.push("--path", ".");
const dockerResourcesBefore = await captureDockerResourceSnapshot(harborEnv, projectRoot);
const datasetGuard =
  localDatasetSnapshot === null
    ? null
    : await attachReadOnlyDatasetSnapshot(localDatasetSnapshot, localDatasetTreeSha256);
const harborExecutionEnv = {
  ...harborEnv,
  PICO_TB_RESOURCE_REGISTRY_PATH: dockerOwnershipRegistryPath,
  PICO_TB_RUN_ID: runId,
  ...(datasetGuard === null ? {} : { PICO_TB_DATASET_FD: "4" }),
};
let harborExecution;
let harborExecutionError;
const cleanupErrors = [];
try {
  if (
    localDatasetPath !== null &&
    (await hashDirectory(localDatasetPath)) !== localDatasetTreeSha256
  ) {
    throw new Error("Terminal-Bench staged dataset changed before Harbor startup");
  }
  harborExecution = await runCaptured(
    join(harborVirtualEnvironment, "bin/python"),
    [join(projectRoot, "benchmarks/terminal_bench_2_1/harbor_bootstrap.py"), ...harborArgs],
    runRoot,
    harborExecutionEnv,
    JSON.stringify({
      socketPath: gatewaySupervisor.socketPath,
      capabilitySeed: gatewayCapabilitySeed,
      runId,
    }),
    {
      inheritedFileDescriptors: datasetGuard === null ? [] : [datasetGuard.descriptor],
    },
  );
} catch (error) {
  harborExecutionError = error;
} finally {
  try {
    await gatewaySupervisor.stop();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await cleanupDockerResources({
      env: harborEnv,
      cwd: projectRoot,
      runId,
      before: dockerResourcesBefore,
      registryPath: dockerOwnershipRegistryPath,
    });
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await datasetGuard?.verifyAndDetach();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await rm(harborVirtualEnvironment, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
}
if (harborExecutionError || cleanupErrors.length > 0) {
  throw new AggregateError(
    [harborExecutionError, ...cleanupErrors].filter(Boolean),
    "Terminal-Bench execution or cleanup failed",
  );
}
if (
  localDatasetSourcePath !== null &&
  (await hashDirectory(localDatasetSourcePath)) !== localDatasetTreeSha256
) {
  throw new Error("Terminal-Bench staged dataset changed during Harbor execution");
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
if (localDatasetSnapshot !== null) {
  await rewriteTextPaths(
    runRoot,
    localDatasetSnapshot.mountPath,
    join(publishedRunRoot, "local-dataset"),
  );
}
await rewriteTextPaths(runRoot, runRoot, publishedRunRoot);
const summary = await normalizeHarborJob({
  jobDir: join(runRoot, "harbor-job", "job"),
  runDir: runRoot,
  runId,
  expectedTasks: expectedTrials,
  expectedTaskNames: tasks,
  expectedAttempts: options.attempts,
  gatewayCapabilitySeed,
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
  const failureScan = await scanTreeForSecrets(runRoot, [
    providerSecret,
    gatewayCapabilitySeed,
    ...gatewayCapabilities,
  ]);
  if (failureScan.matches.length > 0) {
    throw new Error("Failed Terminal-Bench run contained a protected secret");
  }
  await atomicWritePrivateJson(join(runRoot, "run-status.json"), {
    schemaVersion: 1,
    harborExitCode,
    normalized: true,
    publicationGate: "failed",
    secretScan: {
      status: "passed",
      filesScanned: failureScan.filesScanned,
      bytesScanned: failureScan.bytesScanned,
    },
    completedAt: new Date().toISOString(),
  });
  await fsyncTree(runRoot);
  const failedRunRoot = join(quarantineRoot, `failed-${runId}`);
  await rename(runRoot, failedRunRoot);
  await fsyncDirectory(workRunsRoot);
  await fsyncDirectory(quarantineRoot);
  publicationComplete = true;
  await benchmarkLock.release();
  throw new Error(`Terminal-Bench run did not satisfy the publication gate: ${failedRunRoot}`);
}
try {
  let prePublishScan = await scanTreeForSecrets(runRoot, [
    providerSecret,
    gatewayCapabilitySeed,
    ...gatewayCapabilities,
  ]);
  if (prePublishScan.matches.length > 0) {
    throw new Error("Secret canary scan failed");
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await atomicWritePrivateJson(join(runRoot, "run-status.json"), {
      schemaVersion: 1,
      harborExitCode,
      normalized: true,
      secretScan: {
        status: "passed",
        filesScanned: prePublishScan.filesScanned,
        bytesScanned: prePublishScan.bytesScanned,
      },
      completedAt: new Date().toISOString(),
    });
    const nextScan = await scanTreeForSecrets(runRoot, [
      providerSecret,
      gatewayCapabilitySeed,
      ...gatewayCapabilities,
    ]);
    if (
      nextScan.filesScanned === prePublishScan.filesScanned &&
      nextScan.bytesScanned === prePublishScan.bytesScanned
    ) {
      prePublishScan = nextScan;
      break;
    }
    prePublishScan = nextScan;
    if (attempt === 2) {
      throw new Error("Terminal-Bench scan metadata did not stabilize");
    }
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
await benchmarkLock.release();
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

async function prepareLocalDataset(tasks, runRoot, runId) {
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
    await setTaskPrestartNetworkIsolation(taskDestination, runId);
    await assertTaskComposePolicy(taskDestination, allowlistedHostEnv(process.env));
  }
  return destination;
}

async function setTaskPrestartNetworkIsolation(taskRoot, runId) {
  const path = join(taskRoot, "environment", "docker-compose.yaml");
  try {
    await lstat(path);
    throw new Error("Terminal-Bench canary task defines unsupported Compose services");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeFile(path, prestartNetworkOverlay(runId), { mode: 0o600 });
}

async function materializeReadOnlyDatasetSnapshot(sourcePath, runRoot) {
  if (process.platform !== "darwin") {
    throw new Error("Terminal-Bench immutable dataset snapshots currently require macOS");
  }
  const imagePath = join(runRoot, "local-dataset.dmg");
  const mountPath = join(runRoot, "local-dataset-mounted");
  await run(
    "hdiutil",
    ["create", "-quiet", "-srcfolder", sourcePath, "-format", "UDRO", imagePath],
    projectRoot,
    allowlistedHostEnv(process.env),
  );
  const imageSha256 = createHash("sha256")
    .update(await readFile(imagePath))
    .digest("hex");
  return { imagePath, imageSha256, mountPath };
}

async function attachReadOnlyDatasetSnapshot(snapshot, expectedHash) {
  await mkdir(snapshot.mountPath, { mode: 0o700 });
  let realMountPath;
  try {
    await run(
      "hdiutil",
      [
        "attach",
        "-quiet",
        "-readonly",
        "-nobrowse",
        "-mountpoint",
        snapshot.mountPath,
        snapshot.imagePath,
      ],
      projectRoot,
      allowlistedHostEnv(process.env),
    );
    realMountPath = await realpath(snapshot.mountPath);
    const mountIdentity = await readOnlyMountIdentity(realMountPath);
    if ((await hashDirectory(snapshot.mountPath)) !== expectedHash) {
      throw new Error("Terminal-Bench read-only dataset snapshot digest mismatch");
    }
    const directoryHandle = await open(realMountPath, "r");
    return {
      descriptor: directoryHandle.fd,
      async verifyAndDetach() {
        try {
          const currentImageSha256 = createHash("sha256")
            .update(await readFile(snapshot.imagePath))
            .digest("hex");
          if (
            currentImageSha256 !== snapshot.imageSha256 ||
            (await hashDirectory(snapshot.mountPath)) !== expectedHash ||
            (await readOnlyMountIdentity(realMountPath)) !== mountIdentity
          ) {
            throw new Error("Terminal-Bench read-only dataset snapshot identity changed");
          }
        } finally {
          try {
            await directoryHandle.close();
          } finally {
            try {
              await run(
                "hdiutil",
                ["detach", "-quiet", realMountPath],
                projectRoot,
                allowlistedHostEnv(process.env),
              );
            } finally {
              await rm(snapshot.mountPath, { recursive: true, force: true });
            }
          }
        }
      },
    };
  } catch (error) {
    if (realMountPath !== undefined) {
      await run(
        "hdiutil",
        ["detach", "-quiet", realMountPath],
        projectRoot,
        allowlistedHostEnv(process.env),
      ).catch(() => undefined);
    }
    await rm(snapshot.mountPath, { recursive: true, force: true });
    throw error;
  }
}

async function readOnlyMountIdentity(realMountPath) {
  const output = await capture("mount", [], projectRoot);
  const line = output
    .split(/\r?\n/u)
    .find((candidate) => candidate.includes(` on ${realMountPath} (`));
  if (!line || !line.includes("read-only")) {
    throw new Error("Terminal-Bench dataset snapshot is not mounted read-only");
  }
  return line;
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
    if (findZipEnd(candidate) >= 0) {
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
    if (candidate.length >= 512 && validTarHeader(candidate.subarray(0, 512))) {
      for (let offset = 0; offset + 512 <= candidate.length; ) {
        const header = candidate.subarray(offset, offset + 512);
        if (header.every((byte) => byte === 0)) break;
        if (!validTarHeader(header)) {
          throw new Error("Result tar archive has an invalid header checksum");
        }
        const type = String.fromCharCode(header[156] || 0x30);
        if (["1", "2"].includes(type)) {
          throw new Error("Result archive contains a link entry");
        }
        if (!["0", "\0", "5", "7", "x", "g", "L", "K"].includes(type)) {
          throw new Error("Result tar archive contains an unsupported entry type");
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
        if (["0", "\0", "7", "x", "g", "L", "K"].includes(type)) {
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
    const eocd = findZipEnd(candidate);
    if (eocd < 0) throw new Error("Result ZIP archive has no central directory");
    const entries = candidate.readUInt16LE(eocd + 10);
    const centralSize = candidate.readUInt32LE(eocd + 12);
    const centralOffset = candidate.readUInt32LE(eocd + 16);
    const archiveBase = eocd - centralSize - centralOffset;
    const centralStart = archiveBase + centralOffset;
    if (
      entries < 1 ||
      archiveBase < 0 ||
      centralStart + centralSize > candidate.length ||
      entries > 100_000
    ) {
      throw new Error("Result ZIP archive exceeds the scan limit");
    }
    let offset = centralStart;
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
      const localOffset = archiveBase + candidate.readUInt32LE(offset + 42);
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
    if (offset !== centralStart + centralSize) {
      throw new Error("Result ZIP central directory length is invalid");
    }
  }
  function findZipEnd(candidate) {
    const minimum = Math.max(0, candidate.length - 65_557);
    for (let offset = candidate.length - 22; offset >= minimum; offset -= 1) {
      if (
        candidate.readUInt32LE(offset) === 0x06054b50 &&
        candidate.readUInt16LE(offset + 10) > 0
      ) {
        return offset;
      }
    }
    return -1;
  }
  function validTarHeader(header) {
    if (header.length !== 512 || header.every((byte) => byte === 0)) return false;
    const checksumText = header.subarray(148, 156).toString("ascii").replace(/\0.*$/u, "").trim();
    const expected = Number.parseInt(checksumText, 8);
    if (!Number.isSafeInteger(expected)) return false;
    let actual = 0;
    for (let index = 0; index < header.length; index += 1) {
      actual += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    return actual === expected;
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
    stopSync() {
      if (child.exitCode === null) child.kill("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    },
  };
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

import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildPicoBundle } from "./build-bundle.mjs";
import { normalizeHarborJob } from "./normalize-results.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const datasetRef =
  "terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a";
const datasetSourceCommit = "5c8eadf1f393183288fa08b8f73ca9a469cc5e00";
const harborVersion = "0.20.0";
const harborCommit = "459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc";
const harborWheelSha256 = "4b7e981739e64be41c9828022af547532657c955705828ac0c13dd7a6687b556";
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
provider.baseURL = rewriteLoopback(provider.baseURL, options.dockerHostGateway);
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
  ...process.env,
  [benchmarkApiKeyEnv]: providerSecret,
  PYTHONPATH: [projectRoot, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
};
if (sourceApiKeyEnv !== benchmarkApiKeyEnv) delete harborEnv[sourceApiKeyEnv];

const picoCommit = (await capture("git", ["rev-parse", "HEAD"], projectRoot)).trim();
const dirty = (await capture("git", ["status", "--porcelain"], projectRoot)).trim().length > 0;
if (dirty) throw new Error("Benchmark runs require a clean Pico worktree");
const mode = options.mode ?? "canary";
const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
const runId = `${mode}-${timestamp}-${picoCommit.slice(0, 12)}`;
const runRoot = join(projectRoot, "output", "benchmarks", "terminal-bench-2.1", "runs", runId);
await mkdir(runRoot, { recursive: true, mode: 0o700 });
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
const tasks = await resolveTasks(mode, options.task);
const canaryHash = createHash("sha256").update(tasks.join("\n")).digest("hex");
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
    taskCount: tasks.length,
    taskListSha256: canaryHash,
  },
  nodeRuntime: {
    version: "22.14.0",
    archives: {
      linuxX64: "9d942932535988091034dc94cc5f42b6dc8784d6366df3a36c4c9ccb3996f0c2",
      linuxArm64: "8cf30ff7250f9463b53c18f89c6c606dfda70378215b2c905d0a9a8b08bd45e0",
    },
  },
  model: {
    modelRouteId,
    protocol: provider.protocol ?? "openai",
    baseURL: redactUrl(provider.baseURL),
    endpointRewritten: provider.baseURL !== userConfig.providers[providerId].baseURL,
    thinkingEffort: routeConfig.thinkingEffort ?? null,
    apiKeyEnv: benchmarkApiKeyEnv,
  },
  policy: {
    permissionMode: "yolo",
    allowedTools: ["bash", "read_file", "write_file", "edit_file", "glob", "grep", "read_evidence"],
    localCanaryOnly: true,
    leaderboardComparable: false,
    secretInjection: "docker-compose-exec-stdin-frame",
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
  `harbor==${harborVersion}`,
  "harbor",
  "run",
  "--env",
  "docker",
  "--delete",
  "--dataset",
  datasetRef,
  "--agent",
  "benchmarks.terminal_bench_2_1.pico_agent:PicoInstalledAgent",
  "--model",
  modelRouteId,
  "--ak",
  `bundle_path=${bundle.path}`,
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
];
for (const task of tasks) harborArgs.push("--include-task-name", task);
let harborExitCode = 0;
try {
  await run("uvx", harborArgs, projectRoot, harborEnv);
} catch (error) {
  harborExitCode = error.exitCode ?? 1;
}
const secretScan = await scanTreeForSecret(runRoot, providerSecret);
if (secretScan.matches.length > 0) {
  await atomicWritePrivateJson(join(runRoot, "SECURITY-FAILURE.json"), {
    schemaVersion: 1,
    status: "blocked",
    matches: secretScan.matches,
  });
  throw new Error("Secret canary scan failed; result publication is blocked");
}
const summary = await normalizeHarborJob({
  jobDir: join(runRoot, "harbor-job", "job"),
  runDir: runRoot,
  runId,
  expectedTasks: tasks.length || null,
});
await atomicWritePrivateJson(join(runRoot, "run-status.json"), {
  schemaVersion: 1,
  harborExitCode,
  normalized: true,
  secretScan: { status: "passed", filesScanned: secretScan.filesScanned },
  completedAt: new Date().toISOString(),
});
process.stdout.write(`${JSON.stringify({ runId, runRoot, harborExitCode, summary }, null, 2)}\n`);
if (harborExitCode !== 0) process.exitCode = harborExitCode;

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
  if (mode === "full") return [];
  if (mode === "single") {
    if (!singleTask?.startsWith("terminal-bench/")) {
      throw new Error("--task must use terminal-bench/<name>");
    }
    return [singleTask];
  }
  const raw = await readFile(
    join(projectRoot, "benchmarks/terminal_bench_2_1/canary-task-names.txt"),
    "utf8",
  );
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function rewriteLoopback(baseURL, enabled) {
  const url = new URL(baseURL);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Provider URL must not contain userinfo, query, or fragment");
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (!loopback) return baseURL;
  if (!enabled) throw new Error("Loopback provider requires explicit --docker-host-gateway");
  url.hostname = "host.docker.internal";
  return url.toString().replace(/\/$/u, "");
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

async function ensurePinnedDownload(archive, cacheRoot) {
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const destination = join(cacheRoot, archive.name);
  try {
    if (
      createHash("sha256")
        .update(await readFile(destination))
        .digest("hex") === archive.sha256
    ) {
      return destination;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const url = `https://nodejs.org/dist/v22.14.0/${archive.name}`;
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Node archive download returned ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      const digest = createHash("sha256").update(data).digest("hex");
      if (digest !== archive.sha256) throw new Error("Node archive digest mismatch");
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
  throw lastError;
}

async function scanTreeForSecret(root, secret) {
  const encoded = [
    ["raw", Buffer.from(secret)],
    ["json", Buffer.from(JSON.stringify(secret).slice(1, -1))],
    ["url", Buffer.from(encodeURIComponent(secret))],
    ["base64", Buffer.from(Buffer.from(secret).toString("base64"))],
  ];
  const matches = [];
  let filesScanned = 0;
  async function visit(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Result tree contains symlink: ${path}`);
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) await visit(join(path, entry));
      return;
    }
    if (!info.isFile()) return;
    filesScanned += 1;
    const data = await readFile(path);
    for (const [encoding, needle] of encoded) {
      if (needle.length > 0 && data.includes(needle)) {
        matches.push({ path: path.slice(root.length + 1), encoding });
      }
    }
  }
  await visit(root);
  return { matches, filesScanned };
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

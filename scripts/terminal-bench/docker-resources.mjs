import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const projectPattern = /^[a-z0-9][a-z0-9_-]{0,127}$/u;

export async function captureDockerResourceSnapshot(env, cwd) {
  const [containersRaw, networksRaw, volumesRaw] = await Promise.all([
    capture("docker", ["ps", "-aq", "--no-trunc"], cwd, env),
    capture("docker", ["network", "ls", "--quiet", "--filter", "type=custom"], cwd, env),
    capture("docker", ["volume", "ls", "--quiet"], cwd, env),
  ]);
  return {
    containers: new Set(lines(containersRaw)),
    networks: new Set(lines(networksRaw)),
    volumes: new Set(lines(volumesRaw)),
  };
}

export async function cleanupDockerResources({
  env,
  cwd,
  runId,
  before,
  registryPath,
  quietPeriodMs = 2_000,
  pollIntervalMs = 100,
  maxWaitMs = 10_000,
}) {
  const projects = await readOwnedProjects(registryPath, runId);
  const cleanupErrors = [];
  const startedAt = Date.now();
  let quietSince = null;
  while (Date.now() - startedAt < maxWaitMs) {
    const owned = await findOwnedResources(env, cwd, runId, projects);
    await removeEach("container", owned.containers, env, cwd, cleanupErrors);
    await removeEach("network", owned.networks, env, cwd, cleanupErrors);
    await removeEach("volume", owned.volumes, env, cwd, cleanupErrors);
    const observed = owned.containers.size > 0 || owned.networks.size > 0 || owned.volumes.size > 0;
    if (observed) quietSince = null;
    else quietSince ??= Date.now();
    if (quietSince !== null && Date.now() - quietSince >= quietPeriodMs) break;
    await delay(pollIntervalMs);
  }

  const remaining = await findOwnedResources(env, cwd, runId, projects);
  if (
    quietSince === null ||
    Date.now() - quietSince < quietPeriodMs ||
    remaining.containers.size > 0 ||
    remaining.networks.size > 0 ||
    remaining.volumes.size > 0
  ) {
    cleanupErrors.push(new Error("Terminal-Bench owned Docker resource cleanup was unconfirmed"));
  }

  const after = await captureDockerResourceSnapshot(env, cwd);
  const unknown = {
    containers: difference(after.containers, before.containers),
    networks: difference(after.networks, before.networks),
    volumes: difference(after.volumes, before.volumes),
  };
  if (unknown.containers.length > 0 || unknown.networks.length > 0 || unknown.volumes.length > 0) {
    cleanupErrors.push(
      new Error(
        `Terminal-Bench observed unowned Docker resources and left them untouched: ${JSON.stringify(
          unknown,
        )}`,
      ),
    );
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Terminal-Bench Docker cleanup encountered errors");
  }
}

async function readOwnedProjects(path, runId) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return new Set();
    throw error;
  }
  const projects = new Set();
  for (const line of content.split(/\r?\n/u).filter(Boolean)) {
    const record = JSON.parse(line);
    if (
      record?.schemaVersion !== 1 ||
      record.runId !== runId ||
      typeof record.composeProject !== "string" ||
      !projectPattern.test(record.composeProject)
    ) {
      throw new Error("Terminal-Bench Docker ownership registry is invalid");
    }
    projects.add(record.composeProject);
  }
  return projects;
}

async function findOwnedResources(env, cwd, runId, projects) {
  const labels = [
    `pico.terminal-bench.run=${runId}`,
    ...[...projects].map((project) => `com.docker.compose.project=${project}`),
  ];
  const result = {
    containers: new Set(),
    networks: new Set(),
    volumes: new Set(),
  };
  for (const label of labels) {
    const [containersRaw, networksRaw, volumesRaw] = await Promise.all([
      capture("docker", ["ps", "-aq", "--filter", `label=${label}`], cwd, env),
      capture("docker", ["network", "ls", "--quiet", "--filter", `label=${label}`], cwd, env),
      capture("docker", ["volume", "ls", "--quiet", "--filter", `label=${label}`], cwd, env),
    ]);
    for (const value of lines(containersRaw)) result.containers.add(value);
    for (const value of lines(networksRaw)) result.networks.add(value);
    for (const value of lines(volumesRaw)) result.volumes.add(value);
  }
  return result;
}

async function removeEach(kind, values, env, cwd, errors) {
  const command =
    kind === "container"
      ? ["rm", "--force"]
      : kind === "network"
        ? ["network", "rm"]
        : ["volume", "rm", "--force"];
  for (const value of values) {
    try {
      await run("docker", [...command, value], cwd, env);
    } catch (error) {
      errors.push(error);
    }
  }
}

function difference(current, baseline) {
  return [...current].filter((value) => !baseline.has(value)).sort();
}

function lines(value) {
  return value
    .split(/\s+/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function capture(command, args, cwd, env) {
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

function run(command, args, cwd, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

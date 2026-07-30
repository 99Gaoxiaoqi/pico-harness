import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";

export function prestartNetworkOverlay(runId, { localImagesOnly = false } = {}) {
  if (!/^[A-Za-z0-9._-]{1,160}$/u.test(runId)) {
    throw new Error("Terminal-Bench run ID is invalid for Compose");
  }
  return `${[
    "services:",
    "  main:",
    ...(localImagesOnly ? ["    pull_policy: never"] : []),
    "    labels:",
    `      pico.terminal-bench.run: ${runId}`,
    "    networks:",
    "      - default",
    "networks:",
    "  default:",
    "    internal: true",
    "    labels:",
    `      pico.terminal-bench.run: ${runId}`,
  ].join("\n")}\n`;
}

export async function assertTaskComposePolicy(taskRoot, env) {
  const environmentRoot = resolve(taskRoot, "environment");
  const composeFiles = await findComposeFiles(environmentRoot);
  if (composeFiles.length === 0) return;
  if (
    composeFiles.length === 1 &&
    isTrustedPrestartOverlay(await readFile(composeFiles[0], "utf8"))
  ) {
    return;
  }
  const args = ["compose", "--project-directory", environmentRoot];
  for (const path of composeFiles) args.push("-f", path);
  args.push("config", "--format", "json", "--no-normalize");
  const output = await capture("docker", args, environmentRoot, env);
  const config = JSON.parse(output);
  const services = Object.entries(config.services ?? {});
  if (services.length !== 1 || services[0][0] !== "main") {
    throw new Error("Terminal-Bench task Compose may only define the main service");
  }
  const networks = Object.entries(config.networks ?? {});
  if (
    networks.some(
      ([name, network]) =>
        name !== "default" || network.external === true || typeof network.name === "string",
    )
  ) {
    throw new Error("Terminal-Bench task Compose defines an unsafe network");
  }
  for (const [, service] of services) {
    if (
      Array.isArray(service.networks) &&
      service.networks.some((network) => network !== "default")
    ) {
      throw new Error("Terminal-Bench task Compose defines an unsafe service network");
    }
    const networkMode = String(service.network_mode ?? "");
    if (
      service.privileged ||
      ["host", "none"].includes(networkMode) ||
      networkMode.startsWith("container:") ||
      networkMode.startsWith("service:") ||
      service.pid === "host" ||
      service.ipc === "host" ||
      service.cgroup === "host" ||
      service.userns_mode === "host" ||
      (service.cap_add?.length ?? 0) > 0 ||
      (service.devices?.length ?? 0) > 0 ||
      (service.device_cgroup_rules?.length ?? 0) > 0 ||
      (service.security_opt?.length ?? 0) > 0 ||
      (service.volumes_from?.length ?? 0) > 0 ||
      (service.ports?.length ?? 0) > 0 ||
      (service.extra_hosts?.length ?? 0) > 0
    ) {
      throw new Error("Terminal-Bench task Compose violates host isolation");
    }
    for (const volume of service.volumes ?? []) {
      const parts = typeof volume === "string" ? volume.split(":") : null;
      const source = parts ? parts[0] : volume.source;
      const target = parts ? parts[1] : volume.target;
      const type = typeof volume === "string" ? "bind" : volume.type;
      if (
        !["bind", "volume", "tmpfs"].includes(type) ||
        !isAbsolute(String(target)) ||
        sensitiveTarget(String(target)) ||
        String(source).includes("docker.sock") ||
        String(target).includes("docker.sock")
      ) {
        throw new Error("Terminal-Bench task Compose exposes Docker control");
      }
      if (type === "bind") {
        if (typeof source !== "string" || source.length === 0) {
          throw new Error("Terminal-Bench task Compose has an invalid host bind");
        }
        const resolvedSource = resolve(environmentRoot, source);
        const sourceInfo = await lstat(resolvedSource);
        if (!sourceInfo.isFile() && !sourceInfo.isDirectory()) {
          throw new Error("Terminal-Bench task Compose bind source has an unsafe type");
        }
        if (
          resolvedSource !== environmentRoot &&
          !resolvedSource.startsWith(`${environmentRoot}/`)
        ) {
          throw new Error("Terminal-Bench task Compose has an unexpected host bind");
        }
      }
    }
  }
}

function isTrustedPrestartOverlay(value) {
  const match = value.match(
    /^services:\n\x20{2}main:\n(?:\x20{4}pull_policy: never\n)?\x20{4}labels:\n\x20{6}pico\.terminal-bench\.run: ([A-Za-z0-9._-]{1,160})\n\x20{4}networks:\n\x20{6}- default\nnetworks:\n\x20{2}default:\n\x20{4}internal: true\n\x20{4}labels:\n\x20{6}pico\.terminal-bench\.run: ([A-Za-z0-9._-]{1,160})\n$/u,
  );
  return match !== null && match[1] === match[2];
}

async function findComposeFiles(root) {
  const results = [];
  async function visit(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error(`Terminal-Bench task contains a symlink: ${path}`);
    }
    if (!info.isDirectory()) {
      const name = path.slice(path.lastIndexOf("/") + 1);
      if (/^(?:docker-)?compose(?:\.[^.]+)?\.ya?ml$/iu.test(name)) results.push(path);
      return;
    }
    for (const entry of await readdir(path)) await visit(join(path, entry));
  }
  try {
    await visit(root);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return results.sort();
}

function sensitiveTarget(target) {
  if (target === "/tmp/pico-tb21" || target.startsWith("/tmp/pico-tb21/")) return true;
  return !["/workspace", "/logs", "/tests", "/solution", "/tmp"].some(
    (root) => target === root || target.startsWith(`${root}/`),
  );
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

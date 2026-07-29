import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";

export async function assertTaskComposePolicy(taskRoot, env) {
  const environmentRoot = resolve(taskRoot, "environment");
  const composeFiles = await findComposeFiles(environmentRoot);
  if (composeFiles.length === 0) return;
  const args = ["compose", "--project-directory", environmentRoot];
  for (const path of composeFiles) args.push("-f", path);
  args.push("config", "--format", "json");
  const output = await capture("docker", args, environmentRoot, env);
  const config = JSON.parse(output);
  for (const service of Object.values(config.services ?? {})) {
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
      const source = typeof volume === "string" ? volume.split(":", 1)[0] : volume.source;
      const target = typeof volume === "string" ? volume.split(":")[1] : volume.target;
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
  return ["/", "/boot", "/dev", "/etc", "/proc", "/root", "/run", "/sys", "/var/run"].some(
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

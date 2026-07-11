import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { extractBashWritePaths } from "../approval/bash-paths.js";

export type SandboxNetworkPolicy = "deny" | "allow";
export type SandboxBackend = "macos-sandbox-exec" | "linux-bwrap" | "unavailable";

export interface YoloSandboxConfig {
  /** 子进程网络策略，默认拒绝。 */
  network: SandboxNetworkPolicy;
}

export const DEFAULT_YOLO_SANDBOX_CONFIG: Readonly<YoloSandboxConfig> = Object.freeze({
  network: "deny",
});

export type SandboxViolationCode =
  | "sandbox_unavailable"
  | "workspace_write_denied"
  | "sensitive_path_denied"
  | "network_denied"
  | "sandbox_runtime_denied";

export class SandboxViolationError extends Error {
  override readonly name = "SandboxViolationError";

  constructor(
    readonly code: SandboxViolationCode,
    message: string,
  ) {
    super(`[sandbox:${code}] ${message}`);
  }
}

export interface SandboxDecision {
  allowed: boolean;
  code?: SandboxViolationCode;
  reason?: string;
}

export interface SandboxSpawnPlan {
  backend: SandboxBackend;
  command: string;
  args: string[];
  sandboxed: boolean;
}

export interface SandboxRequest {
  command: string;
  shell: string;
  shellArgs: readonly string[];
  cwd: string;
  writableRoots: readonly string[];
  config?: Partial<YoloSandboxConfig>;
  platform?: NodeJS.Platform;
}

/**
 * 高置信的静态预检。它只用于提前返回清晰错误，不替代 OS 沙箱。
 * 未识别的 shell 语法仍会被 buildSandboxSpawnPlan 产生的宿主边界约束。
 */
export function evaluateSandboxCommand(
  command: string,
  cwd: string,
  writableRoots: readonly string[],
  config: Partial<YoloSandboxConfig> = {},
): SandboxDecision {
  const effective = normalizeSandboxConfig(config);
  for (const path of extractBashWritePaths(command)) {
    const target = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
    if (!writableRoots.some((root) => isWithin(resolve(root), target))) {
      return denied("workspace_write_denied", `Bash 写入目标不在授权工作区: ${path}`);
    }
    if (isSensitiveWritePath(target, writableRoots)) {
      return denied("sensitive_path_denied", `Bash 写入敏感路径已拒绝: ${path}`);
    }
  }

  if (effective.network === "deny" && hasExplicitNetworkIntent(command)) {
    return denied("network_denied", "当前 YOLO 沙箱策略禁止子进程访问网络。");
  }
  return { allowed: true };
}

export function buildSandboxSpawnPlan(request: SandboxRequest): SandboxSpawnPlan {
  const config = normalizeSandboxConfig(request.config ?? {});
  const backend = detectSandboxBackend(request.platform ?? process.platform);
  if (backend === "unavailable") {
    throw new SandboxViolationError(
      "sandbox_unavailable",
      "当前宿主没有可用的 OS 沙箱后端，已按 fail-closed 策略拒绝 Bash。",
    );
  }

  const roots = normalizeWritableRoots(request.writableRoots);
  if (backend === "macos-sandbox-exec") {
    return {
      backend,
      command: "/usr/bin/sandbox-exec",
      args: ["-p", buildMacosProfile(roots, config.network), request.shell, ...request.shellArgs],
      sandboxed: true,
    };
  }

  return {
    backend,
    command: findLinuxBwrap(),
    args: buildBwrapArgs(roots, config.network, request.shell, request.shellArgs),
    sandboxed: true,
  };
}

export function detectSandboxBackend(platform: NodeJS.Platform = process.platform): SandboxBackend {
  if (platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    return "macos-sandbox-exec";
  }
  if (platform === "linux" && findLinuxBwrap() !== "") {
    return "linux-bwrap";
  }
  return "unavailable";
}

export function isSensitiveWritePath(
  targetPath: string,
  writableRoots: readonly string[],
): boolean {
  const target = resolve(targetPath);
  return writableRoots.some((root) => {
    const rel = relative(resolve(root), target);
    if (rel === "" || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
    const segments = rel.split(sep);
    const basename = segments.at(-1)?.toLowerCase() ?? "";
    return (
      segments.some((segment) => SENSITIVE_DIRECTORY_NAMES.has(segment.toLowerCase())) ||
      SENSITIVE_FILE_NAMES.has(basename) ||
      basename.startsWith(".env.") ||
      PRIVATE_KEY_FILE_RE.test(basename)
    );
  });
}

function normalizeSandboxConfig(config: Partial<YoloSandboxConfig>): YoloSandboxConfig {
  return { ...DEFAULT_YOLO_SANDBOX_CONFIG, ...config };
}

function normalizeWritableRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.map((root) => resolve(root)))];
}

function buildMacosProfile(roots: readonly string[], network: SandboxNetworkPolicy): string {
  const rules = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl-read)",
    "(allow file-read*)",
    '(allow file-write-data (literal "/dev/null"))',
    '(allow file-write-data (literal "/dev/tty"))',
    ...roots.map((root) => `(allow file-write* (subpath ${sbplString(root)}))`),
    `(deny file-write* (regex #"/(\\.git|\\.ssh|\\.gnupg|\\.aws|\\.docker)(/|$)" #"/(\\.env(\\.[^/]*)?|\\.npmrc|\\.pypirc|credentials|id_(rsa|ed25519|ecdsa)|[^/]*\\.(pem|key))$"))`,
  ];
  if (network === "allow") rules.push("(allow network*)");
  return rules.join("\n");
}

function buildBwrapArgs(
  roots: readonly string[],
  network: SandboxNetworkPolicy,
  shell: string,
  shellArgs: readonly string[],
): string[] {
  const args = [
    "--die-with-parent",
    "--new-session",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
  ];
  if (network === "deny") args.push("--unshare-net");
  for (const root of roots) args.push("--bind", root, root);
  args.push("--", shell, ...shellArgs);
  return args;
}

function findLinuxBwrap(): string {
  for (const candidate of ["/usr/bin/bwrap", "/bin/bwrap"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

function denied(code: SandboxViolationCode, reason: string): SandboxDecision {
  return { allowed: false, code, reason: `[sandbox:${code}] ${reason}` };
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sbplString(value: string): string {
  return JSON.stringify(value);
}

function hasExplicitNetworkIntent(command: string): boolean {
  return EXPLICIT_NETWORK_COMMAND_RE.test(command) || NETWORK_URL_RE.test(command);
}

const SENSITIVE_DIRECTORY_NAMES = new Set([".git", ".ssh", ".gnupg", ".aws", ".docker"]);
const SENSITIVE_FILE_NAMES = new Set([".env", ".npmrc", ".pypirc", "credentials"]);
const PRIVATE_KEY_FILE_RE = /^(?:id_(?:rsa|ed25519|ecdsa)|.*\.(?:pem|key))$/iu;
const EXPLICIT_NETWORK_COMMAND_RE =
  /(?:^|[;&|]\s*|\s)(?:curl|wget|nc|ncat|netcat|ssh|scp|sftp|ftp|telnet|ping)\b/iu;
const NETWORK_URL_RE = /\b(?:https?|wss?|ftp):\/\//iu;

import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { bashCommandFromArgs, extractBashWritePaths } from "../approval/bash-paths.js";
import { isHardlineCommand } from "../approval/manager.js";
import type { ToolCall } from "../schema/message.js";
import type { WorkspaceRoots } from "../tools/workspace-roots.js";

export type SandboxNetworkPolicy = "deny" | "allow";
export type SandboxBackend = "macos-sandbox-exec" | "unavailable";

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

/** YOLO 请求边界：普通工作区操作放行，越界/敏感/网络与 hardline 确定性拒绝。 */
export function evaluateYoloToolCall(
  call: ToolCall,
  workDir: string,
  workspaceRoots: WorkspaceRoots,
  config: Partial<YoloSandboxConfig> = {},
): SandboxDecision {
  if (isHardlineCommand(call.name, call.arguments, workDir)) {
    return denied("workspace_write_denied", "Hardline 高危命令不可通过 YOLO 绕过。");
  }

  if (call.name === "write_file" || call.name === "edit_file") {
    const path = jsonStringField(call.arguments, "path");
    if (!path) return { allowed: true };
    const target = workspaceRoots.resolveUnchecked(path);
    if (!workspaceRoots.isAllowedPath(target)) {
      return denied(
        "workspace_write_denied",
        `写入目标不在授权工作区: ${path}。请先使用 /add-dir 显式授权。`,
      );
    }
    if (isSensitiveWritePath(target, workspaceRoots.list())) {
      return denied("sensitive_path_denied", `YOLO 不允许写入敏感路径: ${path}`);
    }
    return { allowed: true };
  }

  if (call.name === "bash") {
    const command = bashCommandFromArgs(call.arguments);
    return command
      ? evaluateSandboxCommand(command, workDir, workspaceRoots.list(), config)
      : { allowed: true };
  }
  return { allowed: true };
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

  throw new SandboxViolationError("sandbox_unavailable", `未实现的沙箱后端: ${String(backend)}`);
}

export function detectSandboxBackend(platform: NodeJS.Platform = process.platform): SandboxBackend {
  if (platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    return "macos-sandbox-exec";
  }
  // bwrap 可以将整个 root 重新 bind 为可写，但无法按“未来文件名”禁止
  // 嵌套 .git/.env/私钥。在完成 Landlock 等等价边界前，Linux 必须 fail-closed，
  // 不得仅因 bwrap 存在就宣称已强制敏感路径策略。
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
    const normalizedSegments = segments.map((segment) => segment.toLowerCase());
    return (
      normalizedSegments.some((segment) => SENSITIVE_DIRECTORY_NAMES.has(segment)) ||
      basename === "agents.md" ||
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
    `(deny file-read* (regex #"/(\\.ssh|\\.gnupg|\\.aws|\\.kube|\\.docker|\\.azure|gcloud)(/|$)" #"/(\\.env(\\.[^/]*)?|\\.npmrc|\\.pypirc|\\.netrc|\\.git-credentials|credentials|id_(rsa|ed25519|ecdsa)|[^/]*\\.(pem|key))$"))`,
    `(deny file-write* (regex #"/(\\.git|\\.ssh|\\.gnupg|\\.aws|\\.kube|\\.docker|\\.azure|\\.pico|\\.claude|\\.vscode|\\.claw|gcloud)(/|$)" #"/(AGENTS\\.md|\\.env(\\.[^/]*)?|\\.npmrc|\\.pypirc|\\.netrc|\\.git-credentials|credentials|id_(rsa|ed25519|ecdsa)|[^/]*\\.(pem|key))$"))`,
  ];
  if (network === "allow") rules.push("(allow network*)");
  return rules.join("\n");
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

function jsonStringField(args: string, field: string): string | undefined {
  try {
    const value = (JSON.parse(args) as Record<string, unknown>)[field];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

const SENSITIVE_DIRECTORY_NAMES = new Set([
  ".git",
  ".pico",
  ".claude",
  ".vscode",
  ".claw",
  ".ssh",
  ".gnupg",
  ".aws",
  ".docker",
  ".kube",
  ".azure",
  "gcloud",
]);
const SENSITIVE_FILE_NAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  "credentials",
]);
const PRIVATE_KEY_FILE_RE = /^(?:id_(?:rsa|ed25519|ecdsa)|.*\.(?:pem|key))$/iu;
const EXPLICIT_NETWORK_COMMAND_RE =
  /(?:^|[;&|]\s*|\s)(?:curl|wget|nc|ncat|netcat|ssh|scp|sftp|ftp|telnet|ping)\b/iu;
const NETWORK_URL_RE = /\b(?:https?|wss?|ftp):\/\//iu;

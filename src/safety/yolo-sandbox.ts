import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { bashCommandFromArgs, extractBashWritePaths } from "../approval/bash-paths.js";
import { isHardlineCommand } from "../approval/manager.js";
import type { ToolCall } from "../schema/message.js";
import type { WorkspaceRoots } from "../tools/workspace-roots.js";
import {
  DEFAULT_SANDBOX_CONFIG,
  SandboxViolationError,
  buildManagedSpawnPlan,
  createSandboxPolicy,
  detectSandboxBackend,
  isWithinRoot,
  type SandboxBackend,
  type SandboxConfig,
  type SandboxNetworkPolicy,
  type SandboxSpawnPlan as ManagedSandboxSpawnPlan,
  type SandboxViolationCode,
} from "./process-sandbox/index.js";

/** @deprecated 兼容旧调用方；配置现用于 workspace-write，而非 yolo。 */
export type YoloSandboxConfig = SandboxConfig;
export type { SandboxBackend, SandboxNetworkPolicy, SandboxViolationCode };
export { SandboxViolationError, detectSandboxBackend };
export const DEFAULT_YOLO_SANDBOX_CONFIG = DEFAULT_SANDBOX_CONFIG;

export interface SandboxDecision {
  allowed: boolean;
  code?: SandboxViolationCode;
  reason?: string;
}

export type SandboxSpawnPlan = Omit<ManagedSandboxSpawnPlan, "env" | "profile">;

export interface SandboxRequest {
  command: string;
  shell: string;
  shellArgs: readonly string[];
  cwd: string;
  writableRoots: readonly string[];
  config?: Partial<YoloSandboxConfig>;
  platform?: NodeJS.Platform;
  backendExecutable?: string;
}

/** 旧名称保留给后台策略；Hardline 与工作区边界仍是确定性预检。 */
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
    if (!workspaceRoots.isAllowedPath(workspaceRoots.resolveUnchecked(path))) {
      return denied(
        "workspace_write_denied",
        `写入目标不在授权工作区: ${path}。请先使用 /add-dir 显式授权。`,
      );
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

export function evaluateSandboxCommand(
  command: string,
  cwd: string,
  writableRoots: readonly string[],
  config: Partial<YoloSandboxConfig> = {},
): SandboxDecision {
  const effective = { ...DEFAULT_SANDBOX_CONFIG, ...config };
  for (const path of extractBashWritePaths(command)) {
    if (isPseudoDevice(path)) continue;
    const target = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
    if (!writableRoots.some((root) => isWithinRoot(root, target))) {
      return denied("workspace_write_denied", `Bash 写入目标不在授权工作区: ${path}`);
    }
  }
  if (effective.network === "deny" && hasExplicitNetworkIntent(command)) {
    return denied("network_denied", "当前沙箱策略禁止子进程访问网络。");
  }
  return { allowed: true };
}

export function buildSandboxSpawnPlan(request: SandboxRequest): SandboxSpawnPlan {
  const scratchId = createHash("sha256").update(resolve(request.cwd)).digest("hex").slice(0, 20);
  const policy = createSandboxPolicy({
    profile: "workspace-write",
    workspaceRoots: request.writableRoots,
    scratchRoot: resolve(tmpdir(), "pico-sandbox", scratchId),
    config: request.config,
  });
  const plan = buildManagedSpawnPlan({
    command: request.shell,
    args: request.shellArgs,
    cwd: request.cwd,
    origin: "bash",
    policy,
    ...(request.platform ? { platform: request.platform } : {}),
    ...(request.backendExecutable ? { backendExecutable: request.backendExecutable } : {}),
  });
  return {
    backend: plan.backend,
    command: plan.command,
    args: plan.args,
    sandboxed: plan.sandboxed,
  };
}

/** 工作区内部不再设置硬编码敏感写路径。 */
export function isSensitiveWritePath(): boolean {
  return false;
}

function denied(code: SandboxViolationCode, reason: string): SandboxDecision {
  return { allowed: false, code, reason: `[sandbox:${code}] ${reason}` };
}

function isPseudoDevice(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return normalized === "/dev/null" || normalized === "/dev/tty" || normalized === "nul";
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

const EXPLICIT_NETWORK_COMMAND_RE =
  /(?:^|[;&|]\s*|\s)(?:curl|wget|nc|ncat|netcat|ssh|scp|sftp|ftp|telnet|ping)\b/iu;
const NETWORK_URL_RE = /\b(?:https?|wss?|ftp):\/\//iu;

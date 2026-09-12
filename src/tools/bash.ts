// BashTool:执行任意 Shell 命令。
// 对应课程第 06 讲，Bash 是极简工具集原语之一。
// 4 条驾驭底线:超时控制、工作区绑定、错误原样回传、有界执行缓冲。
//
// 独立文件实现,不进 registry-impl.ts,由 default-registry.ts 在合并阶段统一挂载。
// timeout 常量与 resolveBashTimeoutMs 经 registry-impl 门面 re-export,供测试消费。

import type { ChildProcess } from "node:child_process";
import type { BaseTool, ToolExecutionContext } from "./registry.js";
import { WORKSPACE_FILE_SIDE_EFFECTS } from "./registry.js";
import type { ToolDefinition } from "../schema/message.js";
import { ToolAccesses } from "./tool-access.js";
// 跨平台 shell:POSIX 用 /bin/bash,Windows 用 PowerShell(宿主方言见 os/shell.ts)。
import {
  hostShellDialect,
  isWindows,
  resolveShell,
  sanitizeShellProcessEnvironment,
  shellCommandArgs,
} from "../os/shell.js";
import { signalProcessTree } from "../os/process-tree.js";
import { BackgroundManager } from "./background-manager.js";
import type { WorkspaceRoots } from "./workspace-roots.js";
import { isHardlineBashCommand } from "../approval/bash-hardline.js";
import { classifyPowerShellHardlineCommand } from "../approval/powershell-safety.js";
import {
  evaluateSandboxCommand,
  SandboxViolationError,
  type WorkspaceSandboxConfig,
} from "../safety/workspace-sandbox.js";
import {
  DEFAULT_SANDBOX_CONFIG,
  createSandboxPolicy,
  defaultSandboxScratchRoot,
  isWithinRoot,
  managedProcessLauncher,
  shellRuntimeReadRoots,
  type ManagedProcessOrigin,
  type ManagedSpawnRequest,
  type SandboxProfile,
} from "../safety/process-sandbox/index.js";
import {
  MAX_SANDBOX_BOUNDARY_FILESYSTEM_ENTRIES,
  MAX_SANDBOX_BOUNDARY_PATH_CHARS,
  type SandboxBoundaryExpansion,
  type SandboxBoundaryFilesystemEntry,
} from "../safety/permission-profile.js";
import { canonicalizeSandboxBoundaryExpansion } from "../safety/sandbox-boundary-path.js";

/** bash 命令默认执行时间与可信宿主可配置边界。 */
export const DEFAULT_BASH_TIMEOUT_MS = 30_000;
export const MIN_BASH_TIMEOUT_MS = 1_000;
export const MAX_BASH_TIMEOUT_MS = 900_000;
/** 前台命令可持久捕获的最大输出（bytes）。 */
const BASH_EXEC_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const BASH_KILL_GRACE_MS = 750;

export function resolveBashTimeoutMs(value?: unknown): number {
  if (value === undefined) return DEFAULT_BASH_TIMEOUT_MS;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_BASH_TIMEOUT_MS ||
    value > MAX_BASH_TIMEOUT_MS
  ) {
    throw new Error(
      `bashTimeoutMs 必须是 ${MIN_BASH_TIMEOUT_MS}..${MAX_BASH_TIMEOUT_MS} 范围内的整数`,
    );
  }
  return value;
}

export interface BashSandboxPolicyDescriptor {
  readonly profile?: SandboxProfile;
  readonly config?: Partial<WorkspaceSandboxConfig>;
  readonly scratchRoot?: string;
  readonly generation?: number;
  /** True when deny/protected-metadata rules cannot be represented by the OS process policy. */
  readonly hasUnsupportedDenyEntries?: boolean;
  readonly readRoots?: readonly string[];
  readonly writeRoots?: readonly string[];
  readonly readFiles?: readonly string[];
  readonly writeFiles?: readonly string[];
}

export interface BashSandboxDescriptor extends BashSandboxPolicyDescriptor {
  readonly workspaceRoots: WorkspaceRoots;
  readonly consumeNetworkAuthorization?: (toolCallId: string | undefined) => boolean;
}

export interface BashToolOptions {
  readonly allowBackground?: boolean;
  /** Legacy static descriptor. Dynamic hosts should prefer resolveSandbox. */
  readonly sandbox?: BashSandboxDescriptor;
  /** Trusted live descriptor resolver, sampled exactly once at the start of each invocation. */
  readonly resolveSandbox?: () => BashSandboxDescriptor;
  /** 子代理 registry 用独立来源标记，便于审计模型进程平面。 */
  readonly origin?: ManagedProcessOrigin;
  /** 子代理 Bash 由宿主注入最小环境；主 Bash 未设置时仍继承当前用户环境。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 仅由可信宿主注入；未设置时保持 30 秒默认值。 */
  readonly timeoutMs?: number;
}

export class BashTool implements BaseTool {
  readonly permissionCategory = "shell_unsafe" as const;
  readonly fileSideEffects = WORKSPACE_FILE_SIDE_EFFECTS;
  private readonly timeoutMs: number;

  constructor(
    private readonly workDir: string,
    private readonly backgroundManager = new BackgroundManager(),
    private readonly options: BashToolOptions = {},
  ) {
    this.timeoutMs = resolveBashTimeoutMs(options.timeoutMs);
  }

  name(): string {
    return "bash";
  }

  /**
   * bash 命令是任意 shell 文本,无法静态分析出访问哪些文件。
   * 保守策略:声明全资源互斥(kind:"all"),与同批次任何工具都串行。
   * 宁可损失并发,不可错判冲突。
   */
  accesses(): ToolAccesses {
    return ToolAccesses.all();
  }

  definition(): ToolDefinition {
    // Windows 宿主是 PowerShell:工具描述必须告诉模型写 PowerShell 语法,
    // 否则模型按 bash 语法产出,执行语义错乱(工具名保留 bash 以稳定工具集)。
    const windows = isWindows;
    return {
      name: "bash",
      description: windows
        ? "在当前工作区执行任意 PowerShell 命令。支持分号链接多命令与管道;注意 && 与 || 仅 PowerShell 7+ 可用。命令受当前 Session sandbox boundary 约束。"
        : "在当前工作区执行任意 bash 命令。支持链式命令、管道和环境变量。命令受当前 Session sandbox boundary 约束。",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: windows
              ? "要执行的 PowerShell 命令,例如: Get-ChildItem 或 npm test"
              : "要执行的 bash 命令,例如: ls -la 或 npm test",
          },
          background: {
            type: "boolean",
            description: "为 true 时后台启动命令并立即返回 taskId/pid/status,不等待命令结束。",
          },
          boundary_intent: {
            type: "string",
            enum: ["current", "expand"],
            default: "current",
            description:
              "省略时为 current，仅使用当前边界。只有命令依赖明确的额外文件系统或进程网络能力时才用 expand，并声明 required_boundary；未覆盖时先调用 request_sandbox_boundary。",
          },
          required_boundary: sandboxBoundaryExpansionInputSchema(),
        },
        required: ["command"],
        allOf: [
          {
            if: {
              properties: { boundary_intent: { const: "expand" } },
              required: ["boundary_intent"],
            },
            then: { required: ["required_boundary"] },
          },
        ],
        additionalProperties: false,
      },
    };
  }

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    const input = parseBashInput(args);
    const { command, background } = input;
    // A durable boundary may change after request_sandbox_boundary in the same run.
    // Sample one coherent descriptor per invocation and reuse it for declaration
    // preflight, static command checks, and the eventual managed spawn request.
    const sandbox = this.options.resolveSandbox?.() ?? this.options.sandbox;
    this.assertSandboxDescriptorSupported(sandbox);
    this.assertCommandNotHardline(command);
    const requiredBoundary = await selectedBashBoundaryExpansion(input);
    this.assertDeclaredBoundaryCovered(requiredBoundary, sandbox, command);

    const sandboxRequest = this.buildSandboxRequest(
      command,
      background ? "background-bash" : (this.options.origin ?? "bash"),
      sandbox,
      context?.toolCallId,
    );

    if (background) {
      if (this.options.allowBackground === false) {
        throw new Error("当前 bash 工具不允许后台执行");
      }
      const task = this.backgroundManager.start(
        command,
        this.workDir,
        sandboxRequest || this.options.env
          ? {
              ...(sandboxRequest ? { request: sandboxRequest } : {}),
              ...(this.options.env ? { env: this.options.env } : {}),
            }
          : undefined,
      );
      return JSON.stringify({
        taskId: task.taskId,
        pid: task.pid,
        status: task.status,
        command: task.command,
        cwd: task.cwd,
        startedAt: task.startedAt.toISOString(),
      });
    }

    context?.signal?.throwIfAborted();
    const execution = await runForegroundCommand(
      command,
      this.workDir,
      context,
      sandboxRequest,
      this.options.env,
      this.timeoutMs,
    );
    let stdout = execution.output;

    if (
      execution.sandboxed &&
      execution.exitCode !== 0 &&
      /(?:operation not permitted|permission denied|no such file or directory|\bEPERM\b|\bEACCES\b|\bENOENT\b)/iu.test(
        stdout,
      )
    ) {
      throw new SandboxViolationError(
        "sandbox_runtime_denied",
        `OS 沙箱拒绝了子进程操作。${stdout.trim() ? `\n${stdout.trim()}` : ""}`,
      );
    }

    if (execution.timedOut) {
      stdout += `\n[警告: 命令执行超时(${this.timeoutMs / 1000}s),已终止完整子进程树。如果是启动常驻服务,请改用后台运行方式。]`;
    }
    if (execution.exceededExecutionBuffer) {
      stdout += `\n[警告: 终端输出超过执行缓冲上限 ${BASH_EXEC_MAX_BUFFER_BYTES} bytes，完整子进程树已终止；本次结果仅包含已捕获内容。请缩小命令范围或分页输出。]`;
    }
    if (execution.error && !stdout.trim()) {
      stdout = `执行报错: ${execution.error.message}`;
    } else if (execution.exitCode !== 0 && execution.exitCode !== null && !stdout.trim()) {
      stdout = `执行报错: 命令以状态码 ${execution.exitCode} 退出。`;
    }

    // 空输出给明确成功反馈
    if (!stdout.trim()) {
      return "命令执行成功,无终端输出。";
    }

    // 不在工具层截断。>30,000 chars 由 observation 完整落盘并返回摘要。
    return stdout;
  }

  private buildSandboxRequest(
    command: string,
    origin: ManagedProcessOrigin,
    sandbox: BashSandboxDescriptor | undefined,
    toolCallId?: string,
  ): ManagedSpawnRequest {
    const roots = sandbox?.workspaceRoots.processRoots() ?? [this.workDir];
    const profile = sandbox?.profile ?? "danger-full-access";
    const networkAuthorized = sandbox?.consumeNetworkAuthorization?.(toolCallId) === true;
    const sandboxConfig = networkAuthorized
      ? { ...sandbox?.config, network: "allow" as const }
      : sandbox?.config;
    if (sandbox && profile !== "danger-full-access") {
      const writablePaths = [
        ...(profile === "workspace-write" ? roots : []),
        ...(sandbox.writeRoots ?? []),
        ...(sandbox.writeFiles ?? []),
        sandbox.scratchRoot ?? defaultSandboxScratchRoot(this.workDir),
      ];
      const decision = evaluateSandboxCommand(command, this.workDir, writablePaths, sandboxConfig);
      if (!decision.allowed) {
        throw new SandboxViolationError(
          decision.code ?? "workspace_write_denied",
          decision.reason?.replace(/^\[sandbox:[^\]]+\]\s*/u, "") ?? "Bash 请求被沙箱策略拒绝。",
        );
      }
    }
    const shell = resolveShell();
    const processEnvironment = sanitizeShellProcessEnvironment(this.options.env ?? process.env);
    const request: ManagedSpawnRequest = {
      command: shell,
      args: shellCommandArgs(shell, command),
      cwd: this.workDir,
      env: processEnvironment,
      origin,
      policy: createSandboxPolicy({
        profile,
        workspaceRoots: roots,
        scratchRoot: sandbox?.scratchRoot ?? defaultSandboxScratchRoot(this.workDir),
        readRoots: [
          ...shellRuntimeReadRoots(command, processEnvironment),
          ...(sandbox?.readRoots ?? []),
        ],
        ...(sandbox?.writeRoots ? { writeRoots: sandbox.writeRoots } : {}),
        ...(sandbox?.readFiles ? { readFiles: sandbox.readFiles } : {}),
        ...(sandbox?.writeFiles ? { writeFiles: sandbox.writeFiles } : {}),
        ...(sandboxConfig ? { config: sandboxConfig } : {}),
        generation: sandbox?.generation ?? sandbox?.workspaceRoots.generation() ?? 0,
      }),
    };
    sandbox?.workspaceRoots.consumeAllProcessAuthorizations();
    return request;
  }

  private assertDeclaredBoundaryCovered(
    requiredBoundary: SandboxBoundaryExpansion | undefined,
    sandbox: BashSandboxDescriptor | undefined,
    command: string,
  ): void {
    if (
      !requiredBoundary ||
      !sandbox ||
      (sandbox.profile ?? "danger-full-access") === "danger-full-access"
    ) {
      return;
    }

    const missingFilesystem = (requiredBoundary.filesystem?.entries ?? []).filter(
      (entry) =>
        !sandboxDescriptorCoversEntry(sandbox, this.workDir, command, this.options.env, entry),
    );
    const missingNetwork =
      requiredBoundary.network?.enabled === true && !sandboxDescriptorAllowsNetwork(sandbox);
    if (missingFilesystem.length === 0 && !missingNetwork) return;

    const missing = [
      ...(missingFilesystem.length > 0 ? ["filesystem"] : []),
      ...(missingNetwork ? ["network"] : []),
    ].join(" and ");
    throw new SandboxViolationError(
      "sandbox_boundary_required",
      `Bash required_boundary 的 ${missing} 权限尚未被当前 sandbox descriptor 覆盖，未启动任何进程。请先调用 request_sandbox_boundary；批准后使用相同 boundary_intent=expand 与 required_boundary 重试。required_boundary=${JSON.stringify(requiredBoundary)}`,
      requiredBoundary,
    );
  }

  private assertSandboxDescriptorSupported(sandbox: BashSandboxDescriptor | undefined): void {
    if (sandbox?.hasUnsupportedDenyEntries !== true) return;
    throw new SandboxViolationError(
      "policy_compilation_failed",
      "当前 managed permission profile 包含 OS 进程沙箱尚不能表达的显式 deny 或 protectedMetadata deny_write 限制；为防止降权失效，Bash 已 fail-closed，未启动任何进程。",
    );
  }

  private assertCommandNotHardline(command: string): void {
    const hardline =
      hostShellDialect() === "bash"
        ? isHardlineBashCommand(command, this.workDir)
        : classifyPowerShellHardlineCommand(command) !== undefined;
    if (hardline) {
      throw new Error("Hardline 高危命令不可审批绕过，系统直接拒绝。");
    }
  }
}

interface ParsedBashInput {
  readonly command: string;
  readonly background: boolean;
  readonly boundaryIntent: "current" | "expand";
  readonly requiredBoundary?: unknown;
}

function parseBashInput(args: string): ParsedBashInput {
  let value: unknown;
  try {
    value = JSON.parse(args);
  } catch {
    throw new Error("参数解析失败: 期望 JSON 含 command 字段");
  }
  if (!isRecord(value)) throw new Error("参数解析失败: 期望 JSON 含 command 字段");
  const boundaryIntent = value["boundary_intent"] ?? "current";
  if (boundaryIntent !== "current" && boundaryIntent !== "expand") {
    throw new Error("bash boundary_intent 必须是 current 或 expand");
  }
  return {
    command: typeof value["command"] === "string" ? value["command"] : "",
    background: value["background"] === true,
    boundaryIntent,
    ...("required_boundary" in value ? { requiredBoundary: value["required_boundary"] } : {}),
  };
}

async function selectedBashBoundaryExpansion(
  input: ParsedBashInput,
): Promise<SandboxBoundaryExpansion | undefined> {
  if (input.boundaryIntent === "current") return undefined;
  if (input.requiredBoundary === undefined) {
    throw new Error("bash required_boundary is required when boundary_intent is expand");
  }
  try {
    return await canonicalizeSandboxBoundaryExpansion(input.requiredBoundary);
  } catch (error) {
    throw new Error(
      `bash required_boundary 无效: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function sandboxDescriptorCoversEntry(
  sandbox: BashSandboxDescriptor,
  workDir: string,
  command: string,
  env: NodeJS.ProcessEnv | undefined,
  entry: SandboxBoundaryFilesystemEntry,
): boolean {
  const profile = sandbox.profile ?? "danger-full-access";
  if (profile === "danger-full-access") return true;
  const workspaceRoots = sandbox.workspaceRoots.processRoots();
  const scratchRoot = sandbox.scratchRoot ?? defaultSandboxScratchRoot(workDir);
  const writeRoots = [
    ...(profile === "workspace-write" ? workspaceRoots : []),
    ...(sandbox.writeRoots ?? []),
    scratchRoot,
  ];
  const processEnvironment = sanitizeShellProcessEnvironment(env ?? process.env);
  const readRoots = [
    ...shellRuntimeReadRoots(command, processEnvironment),
    ...(sandbox.readRoots ?? []),
    ...workspaceRoots,
    ...writeRoots,
  ];
  const writeFiles = sandbox.writeFiles ?? [];
  const readFiles = [...(sandbox.readFiles ?? []), ...writeFiles];
  const roots = entry.access === "write" ? writeRoots : readRoots;
  if (roots.some((root) => isWithinRoot(root, entry.path))) return true;
  if (entry.scope !== "exact") return false;
  const files = entry.access === "write" ? writeFiles : readFiles;
  return files.some((path) => sameSandboxPath(path, entry.path));
}

function sandboxDescriptorAllowsNetwork(sandbox: BashSandboxDescriptor): boolean {
  const profile = sandbox.profile ?? "danger-full-access";
  if (profile === "danger-full-access") return true;
  if (profile === "read-only") return sandbox.config?.network === "allow";
  return (sandbox.config?.network ?? DEFAULT_SANDBOX_CONFIG.network) === "allow";
}

function sameSandboxPath(left: string, right: string): boolean {
  return isWithinRoot(left, right) && isWithinRoot(right, left);
}

function sandboxBoundaryExpansionInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    description:
      "仅在 boundary_intent=expand 时使用。声明命令所需的最小、规范化绝对路径或进程网络能力；批准后重试时原样重复。",
    properties: {
      filesystem: {
        type: "object",
        properties: {
          entries: {
            type: "array",
            minItems: 1,
            maxItems: MAX_SANDBOX_BOUNDARY_FILESYSTEM_ENTRIES,
            items: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  minLength: 1,
                  maxLength: MAX_SANDBOX_BOUNDARY_PATH_CHARS,
                  description: "规范化绝对路径；文件用 exact，已存在目录用 subtree。",
                },
                access: { type: "string", enum: ["read", "write"] },
                scope: { type: "string", enum: ["exact", "subtree"] },
              },
              required: ["path", "access", "scope"],
              additionalProperties: false,
            },
          },
        },
        required: ["entries"],
        additionalProperties: false,
      },
      network: {
        type: "object",
        description: "仅当进程需要套接字（包括 loopback 或监听端口）时声明。",
        properties: { enabled: { type: "boolean", const: true } },
        required: ["enabled"],
        additionalProperties: false,
      },
    },
    anyOf: [{ required: ["filesystem"] }, { required: ["network"] }],
    additionalProperties: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ForegroundCommandResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  exceededExecutionBuffer: boolean;
  sandboxed: boolean;
  error?: Error;
}

function runForegroundCommand(
  command: string,
  cwd: string,
  context?: ToolExecutionContext,
  sandboxRequest?: ManagedSpawnRequest,
  env?: NodeJS.ProcessEnv,
  timeoutMs = DEFAULT_BASH_TIMEOUT_MS,
): Promise<ForegroundCommandResult> {
  const shell = resolveShell();

  return new Promise<ForegroundCommandResult>((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    let sandboxed = false;
    try {
      const managed = managedProcessLauncher.launch(
        sandboxRequest ?? {
          command: shell,
          args: shellCommandArgs(shell, command),
          cwd,
          env: sanitizeShellProcessEnvironment(env ?? process.env),
          origin: "bash",
          policy: createSandboxPolicy({
            profile: "danger-full-access",
            workspaceRoots: [cwd],
            scratchRoot: defaultSandboxScratchRoot(cwd),
          }),
        },
        {
          detached: !isWindows,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child = managed.child;
      sandboxed = managed.plan.sandboxed;
    } catch (error) {
      resolvePromise({
        output: "",
        exitCode: null,
        timedOut: false,
        exceededExecutionBuffer: false,
        sandboxed: false,
        error: asError(error),
      });
      return;
    }

    const chunks: string[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    let exceededExecutionBuffer = false;
    let childError: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const killAttempts: Promise<boolean>[] = [];

    const signalTree = (signal: NodeJS.Signals): void => {
      killAttempts.push(signalProcessTree(child, signal).catch(() => false));
    };
    const forceKill = (): void => signalTree("SIGKILL");
    const terminateWithGrace = (): void => {
      signalTree("SIGTERM");
      if (killTimer) return;
      killTimer = setTimeout(forceKill, BASH_KILL_GRACE_MS);
      killTimer.unref();
    };
    const emit = (stream: "stdout" | "stderr", chunk: string): void => {
      try {
        context?.onOutput?.({ stream, chunk });
      } catch {
        // Reporter 是观察者，不得因渲染错误中断物理命令。
      }

      if (exceededExecutionBuffer) return;
      const bytes = Buffer.byteLength(chunk);
      const remaining = BASH_EXEC_MAX_BUFFER_BYTES - capturedBytes;
      if (bytes <= remaining) {
        chunks.push(chunk);
        capturedBytes += bytes;
        return;
      }
      if (remaining > 0) {
        chunks.push(truncateUtf8Bytes(chunk, remaining));
        capturedBytes = BASH_EXEC_MAX_BUFFER_BYTES;
      }
      exceededExecutionBuffer = true;
      forceKill();
    };
    const cleanup = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (context?.signal && abortListener) {
        context.signal.removeEventListener("abort", abortListener);
      }
    };
    const abortListener = (): void => {
      // 中断是用户的显式意图，立即杀整组，不给孙进程继续写文件的宽限。
      forceKill();
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => emit("stdout", chunk));
    child.stderr?.on("data", (chunk: string) => emit("stderr", chunk));
    child.once("error", (error) => {
      childError = asError(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      void Promise.allSettled(killAttempts).then(() => {
        if (context?.signal?.aborted) {
          rejectPromise(abortError(context.signal));
          return;
        }
        resolvePromise({
          output: chunks.join(""),
          exitCode,
          timedOut,
          exceededExecutionBuffer,
          sandboxed,
          ...(childError ? { error: childError } : {}),
        });
      });
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateWithGrace();
    }, timeoutMs);
    timeoutTimer.unref();

    if (context?.signal) {
      if (context.signal.aborted) {
        abortListener();
      } else {
        context.signal.addEventListener("abort", abortListener, { once: true });
      }
    }
  });
}

function truncateUtf8Bytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

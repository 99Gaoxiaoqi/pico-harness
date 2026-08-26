// BashTool:执行任意 Shell 命令。
// 对应课程第 06 讲,YOLO 哲学核心,极简工具集原语之一。
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
  type YoloSandboxConfig,
} from "../safety/yolo-sandbox.js";
import {
  createSandboxPolicy,
  defaultSandboxScratchRoot,
  managedProcessLauncher,
  shellRuntimeReadRoots,
  type ManagedProcessOrigin,
  type ManagedSpawnRequest,
  type SandboxProfile,
} from "../safety/process-sandbox/index.js";

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

export class BashTool implements BaseTool {
  readonly fileSideEffects = WORKSPACE_FILE_SIDE_EFFECTS;
  private readonly timeoutMs: number;

  constructor(
    private readonly workDir: string,
    private readonly backgroundManager = new BackgroundManager(),
    private readonly options: {
      allowBackground?: boolean;
      /** 仅由可信宿主注入；一旦注入，无 OS 后端时 Bash fail-closed。 */
      sandbox?: {
        workspaceRoots: WorkspaceRoots;
        config?: Partial<YoloSandboxConfig>;
        profile?: SandboxProfile;
        scratchRoot?: string;
        generation?: number;
      };
      /** 子代理 registry 用独立来源标记，便于审计模型进程平面。 */
      origin?: ManagedProcessOrigin;
      /** 子代理 Bash 由宿主注入最小环境；主 Bash 未设置时仍继承当前用户环境。 */
      env?: NodeJS.ProcessEnv;
      /** 仅由可信宿主注入；未设置时保持 30 秒默认值。 */
      timeoutMs?: number;
    } = {},
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
        ? "在当前工作区执行任意 PowerShell 命令。支持分号链接多命令与管道;注意 && 与 || 仅 PowerShell 7+ 可用。返回标准输出与错误的合并结果。"
        : "在当前工作区执行任意的 bash 命令。支持链式命令(如 &&)、管道和环境变量。返回标准输出与错误的合并结果。",
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
        },
        required: ["command"],
      },
    };
  }

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    let command: string;
    let background: boolean;
    try {
      const input = JSON.parse(args) as { command?: string; background?: boolean };
      command = input.command ?? "";
      background = input.background === true;
    } catch {
      throw new Error("参数解析失败: 期望 JSON 含 command 字段");
    }

    const sandboxRequest = this.buildSandboxRequest(
      command,
      background ? "background-bash" : (this.options.origin ?? "bash"),
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
      /(?:operation not permitted|permission denied|\bEPERM\b|\bEACCES\b)/iu.test(stdout)
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

  private buildSandboxRequest(command: string, origin: ManagedProcessOrigin): ManagedSpawnRequest {
    const hardline =
      hostShellDialect() === "bash"
        ? isHardlineBashCommand(command, this.workDir)
        : classifyPowerShellHardlineCommand(command) !== undefined;
    if (hardline) {
      throw new Error("Hardline 高危命令不可审批绕过，系统直接拒绝。");
    }
    const sandbox = this.options.sandbox;
    const roots = sandbox?.workspaceRoots.processRoots() ?? [this.workDir];
    const profile = sandbox?.profile ?? "danger-full-access";
    if (sandbox && profile !== "danger-full-access") {
      const decision = evaluateSandboxCommand(command, this.workDir, roots, sandbox.config);
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
        readRoots: shellRuntimeReadRoots(command, processEnvironment),
        ...(sandbox?.config ? { config: sandbox.config } : {}),
        generation: sandbox?.generation ?? sandbox?.workspaceRoots.generation() ?? 0,
      }),
    };
    sandbox?.workspaceRoots.consumeAllProcessAuthorizations();
    return request;
  }
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

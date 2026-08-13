// BashTool:执行任意 Shell 命令。
// 对应课程第 06 讲,YOLO 哲学核心,极简工具集原语之一。
// 4 条驾驭底线:超时控制、工作区绑定、错误原样回传、有界执行缓冲。
//
// 独立文件实现,不进 registry-impl.ts,由 default-registry.ts 在合并阶段统一挂载。
// timeout 常量与 resolveBashTimeoutMs 经 registry-impl 门面 re-export,供测试消费。

import { spawn, type ChildProcess } from "node:child_process";
import type { BaseTool, ToolExecutionContext } from "./registry.js";
import { WORKSPACE_FILE_SIDE_EFFECTS } from "./registry.js";
import type { ToolDefinition } from "../schema/message.js";
import { ToolAccesses } from "./tool-access.js";
// 跨平台 shell:Windows 上统一走 Git Bash,避免 cmd.exe 不识别 POSIX 语义。
import {
  isWindows,
  resolveShell,
  sanitizeShellProcessEnvironment,
  shellCommandArgs,
} from "../os/shell.js";
import { signalProcessTree } from "../os/process-tree.js";
import { BackgroundManager } from "./background-manager.js";
import type { WorkspaceRoots } from "./workspace-roots.js";
import { isHardlineBashCommand } from "../approval/bash-hardline.js";
import {
  buildSandboxSpawnPlan,
  evaluateSandboxCommand,
  SandboxViolationError,
  type SandboxSpawnPlan,
  type YoloSandboxConfig,
} from "../safety/yolo-sandbox.js";

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
      };
      /** 子代理 Bash 由宿主注入最小环境；主 Bash 未设置时仍继承当前用户环境。 */
      env?: NodeJS.ProcessEnv;
      /** 仅��可信宿主注入；未设置时保持 30 秒默认值。 */
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
    return {
      name: "bash",
      description:
        "在当前工作区执行任意的 bash 命令。支持链式命令(如 &&)、管道和环境变量。返回标准输出与错误的合并结果。",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的 bash 命令,例如: ls -la 或 npm test" },
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

    const sandboxPlan = this.buildSandboxPlan(command);

    if (background) {
      if (this.options.allowBackground === false) {
        throw new Error("当前 bash 工具不允许后台执行");
      }
      const task = this.backgroundManager.start(
        command,
        this.workDir,
        sandboxPlan || this.options.env
          ? {
              ...(sandboxPlan ? { executable: sandboxPlan.command, args: sandboxPlan.args } : {}),
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
      sandboxPlan,
      this.options.env,
      this.timeoutMs,
    );
    let stdout = execution.output;

    if (
      sandboxPlan?.sandboxed === true &&
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

  private buildSandboxPlan(command: string): SandboxSpawnPlan | undefined {
    if (isHardlineBashCommand(command, this.workDir)) {
      throw new Error("Hardline 高危命令不可审批绕过，系统直接拒绝。");
    }
    const sandbox = this.options.sandbox;
    if (!sandbox) return undefined;
    const roots = sandbox.workspaceRoots.list();
    const decision = evaluateSandboxCommand(command, this.workDir, roots, sandbox.config);
    if (!decision.allowed) {
      throw new SandboxViolationError(
        decision.code ?? "workspace_write_denied",
        decision.reason?.replace(/^\[sandbox:[^\]]+\]\s*/u, "") ?? "Bash 请求被沙箱策略拒绝。",
      );
    }
    const shell = resolveShell();
    return buildSandboxSpawnPlan({
      command,
      shell,
      shellArgs: shellCommandArgs(shell, command),
      cwd: this.workDir,
      writableRoots: roots,
      ...(sandbox.config ? { config: sandbox.config } : {}),
    });
  }
}

interface ForegroundCommandResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  exceededExecutionBuffer: boolean;
  error?: Error;
}

function runForegroundCommand(
  command: string,
  cwd: string,
  context?: ToolExecutionContext,
  sandboxPlan?: SandboxSpawnPlan,
  env?: NodeJS.ProcessEnv,
  timeoutMs = DEFAULT_BASH_TIMEOUT_MS,
): Promise<ForegroundCommandResult> {
  const shell = resolveShell();

  return new Promise<ForegroundCommandResult>((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawn(
        sandboxPlan?.command ?? shell,
        sandboxPlan?.args ?? shellCommandArgs(shell, command),
        {
          cwd,
          detached: !isWindows,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: sanitizeShellProcessEnvironment(env ?? process.env),
        },
      );
    } catch (error) {
      resolvePromise({
        output: "",
        exitCode: null,
        timedOut: false,
        exceededExecutionBuffer: false,
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

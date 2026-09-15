import { scheduleDeadline, type ScheduledDeadline } from "@pico/runtime/deadline";

export interface ApprovalResult {
  allowed: boolean;
  reason: string;
  modifiedContent?: string;
  allowForSession?: boolean;
}

export interface ApprovalPreview {
  target: string;
  summary: string;
  diff?: string;
  truncated?: boolean;
}

export interface ApprovalNotice<SessionScope = unknown> {
  readonly kind: "tool";
  taskId: string;
  toolName: string;
  args: string;
  providerCallId: string;
  message: string;
  preview?: ApprovalPreview;
  diff?: string;
  sessionScope?: SessionScope;
}

export type ApprovalNotifier<SessionScope = unknown> = (
  notice: ApprovalNotice<SessionScope>,
) => void;

export interface ApprovalManagerLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

const NOOP_LOGGER: ApprovalManagerLogger = {
  info: () => undefined,
  warn: () => undefined,
};

interface PendingApproval<SessionScope> {
  resolve: (result: ApprovalResult) => void;
  reject: (reason: unknown) => void;
  deadline: ScheduledDeadline;
  toolName: string;
  args: string;
  sessionScope?: SessionScope;
  signal?: AbortSignal;
  abortListener?: () => void;
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Host-side, in-memory human approval state machine. Session policy is opaque to this class:
 * the Runtime supplies it and the UI applies it after approval.
 */
export class ApprovalManager<SessionScope = unknown> {
  private readonly pendingTasks = new Map<string, PendingApproval<SessionScope>>();

  constructor(
    private readonly timeoutMs: number = DEFAULT_APPROVAL_TIMEOUT_MS,
    private readonly logger: ApprovalManagerLogger = NOOP_LOGGER,
  ) {}

  waitForApproval(
    taskId: string,
    toolName: string,
    args: string,
    notify: ApprovalNotifier<SessionScope>,
    diff: string | undefined,
    signal: AbortSignal | undefined,
    options: { sessionScope?: SessionScope; providerCallId: string; reason?: string },
  ): Promise<ApprovalResult> {
    signal?.throwIfAborted();
    const reason = options.reason ?? "工具调用需要交互审批";
    const message = `⚠ **操作审批请求**
Agent 试图执行以下动作:
- 工具: ${toolName}
- 参数: ${args}
- 原因: ${reason}
任务 ID: **${taskId}**
👉 请回复 "approve ${taskId}" 同意放行,或 "reject ${taskId}" 拒绝执行。`;

    return new Promise<ApprovalResult>((resolve, reject) => {
      // A pending approval must keep the host alive until settlement; AbortSignal.timeout does not.
      const deadline = scheduleDeadline(() => {
        const entry = this.takePendingTask(taskId);
        if (!entry) return;
        this.logger.warn(
          { taskId, timeoutMs: this.timeoutMs },
          `[Approval] 任务 ${taskId} 审批超时,自动拒绝。`,
        );
        entry.resolve({
          allowed: false,
          reason: `审批超时(${Math.floor(this.timeoutMs / 60000)} 分钟无人响应),系统自动拒绝。`,
        });
      }, this.timeoutMs);
      const entry: PendingApproval<SessionScope> = {
        resolve,
        reject,
        deadline,
        toolName,
        args,
        ...(options.sessionScope !== undefined ? { sessionScope: options.sessionScope } : {}),
      };
      if (signal) {
        entry.signal = signal;
        entry.abortListener = () => {
          this.cancelApproval(
            taskId,
            "审批请求已因本轮中止而取消。",
            signal.reason ?? new DOMException("aborted", "AbortError"),
          );
        };
      }
      this.pendingTasks.set(taskId, entry);
      if (signal && entry.abortListener) {
        signal.addEventListener("abort", entry.abortListener, { once: true });
        if (signal.aborted) {
          entry.abortListener();
          return;
        }
      }
      try {
        notify({
          kind: "tool",
          taskId,
          toolName,
          args,
          providerCallId: options.providerCallId,
          message,
          preview: buildApprovalPreview(toolName, args, diff, reason),
          ...(diff !== undefined ? { diff } : {}),
          ...(options.sessionScope !== undefined ? { sessionScope: options.sessionScope } : {}),
        });
        this.logger.info({ taskId }, `[Approval] 已发送审批请求,执行流挂起等待...`);
      } catch (error) {
        this.takePendingTask(taskId);
        reject(error);
      }
    });
  }

  resolveApproval(taskId: string, allowed: boolean, reason: string): boolean {
    const entry = this.takePendingTask(taskId);
    if (!entry) {
      this.logger.warn(
        { taskId },
        `[Approval] 找不到对应的 TaskID: ${taskId},可能已超时或处理完毕。`,
      );
      return false;
    }
    this.logger.info(
      { taskId, allowed, reason },
      `[Approval] 收到审批结果 (TaskID: ${taskId}, Allowed: ${allowed}): ${reason}`,
    );
    entry.resolve({ allowed, reason });
    return true;
  }

  resolveApprovalForSession(taskId: string, reason: string): boolean {
    const entry = this.takePendingTask(taskId);
    if (!entry) {
      this.logger.warn(
        { taskId },
        `[Approval] 找不到对应的 TaskID: ${taskId},可能已超时或处理完毕。`,
      );
      return false;
    }
    entry.resolve({ allowed: true, reason, allowForSession: true });
    return true;
  }

  resolveApprovalWithModify(taskId: string, reason: string, modifiedContent: string): boolean {
    const entry = this.takePendingTask(taskId);
    if (!entry) {
      this.logger.warn(
        { taskId },
        `[Approval] 找不到对应的 TaskID: ${taskId},可能已超时或处理完毕。`,
      );
      return false;
    }
    this.logger.info(
      { taskId, reason, modified: true },
      `[Approval] 收到审批结果 (TaskID: ${taskId}, Modified): ${reason}`,
    );
    entry.resolve({ allowed: true, reason, modifiedContent });
    return true;
  }

  cancelApproval(taskId: string, reason = "审批请求已取消。", abortReason?: unknown): boolean {
    const entry = this.takePendingTask(taskId);
    if (!entry) return false;
    this.logger.info(
      { taskId, reason },
      `[Approval] 审批请求已取消 (TaskID: ${taskId}): ${reason}`,
    );
    if (abortReason !== undefined) entry.reject(abortReason);
    else entry.resolve({ allowed: false, reason });
    return true;
  }

  get pendingCount(): number {
    return this.pendingTasks.size;
  }

  getPendingTask(
    taskId: string,
  ): { toolName: string; args: string; sessionScope?: SessionScope } | undefined {
    const task = this.pendingTasks.get(taskId);
    return task
      ? {
          toolName: task.toolName,
          args: task.args,
          ...(task.sessionScope !== undefined ? { sessionScope: task.sessionScope } : {}),
        }
      : undefined;
  }

  clear(): void {
    for (const entry of this.pendingTasks.values()) this.removeListeners(entry);
    this.pendingTasks.clear();
  }

  private takePendingTask(taskId: string): PendingApproval<SessionScope> | undefined {
    const entry = this.pendingTasks.get(taskId);
    if (!entry) return undefined;
    this.pendingTasks.delete(taskId);
    this.removeListeners(entry);
    return entry;
  }

  private removeListeners(entry: PendingApproval<SessionScope>): void {
    entry.deadline.cancel();
    if (entry.signal && entry.abortListener)
      entry.signal.removeEventListener("abort", entry.abortListener);
  }
}

function buildApprovalPreview(
  toolName: string,
  args: string,
  diff: string | undefined,
  reason: string,
): ApprovalPreview {
  const target = approvalPreviewTarget(toolName, args);
  const preview: ApprovalPreview = {
    target,
    summary: reason ? `${approvalPreviewSummary(toolName, target, args)}；${reason}` : "",
  };
  if (diff !== undefined) {
    preview.diff = diff;
    preview.truncated = diff.includes("已截断");
  }
  return preview;
}

function approvalPreviewSummary(toolName: string, target: string, args: string): string {
  if (toolName === "write_file") return `write_file 写入 ${target}`;
  if (toolName === "edit_file") return `edit_file 修改 ${target}`;
  if (toolName === "read_file") return `read_file 读取 ${target}`;
  if (toolName === "bash") {
    const command = parseBashCommand(args);
    if (command && findBashWriteRedirectTarget(command)) return `bash 执行并写入 ${target}`;
    return `bash 执行 ${target}`;
  }
  return `${toolName} ${target}`;
}

function approvalPreviewTarget(toolName: string, args: string): string {
  const parsed = parseArgsObject(args);
  if (parsed) {
    if (toolName === "bash") {
      const command = parsed["command"];
      if (typeof command === "string" && command.trim()) {
        return compactPreview(findBashWriteRedirectTarget(command) ?? command.trim(), 160);
      }
    }
    const keys =
      toolName === "bash"
        ? ["command", "path", "file", "url", "query"]
        : ["path", "file", "command", "url", "query"];
    for (const key of keys) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) return compactPreview(value.trim(), 160);
    }
  }
  return compactPreview(args, 160);
}

function parseArgsObject(args: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseBashCommand(args: string): string | undefined {
  const command = parseArgsObject(args)?.["command"];
  return typeof command === "string" ? command : undefined;
}

function findBashWriteRedirectTarget(command: string): string | undefined {
  return command.match(/\d*>>?\s*(?!&)([^\s|;&]+)/u)?.[1]?.replace(/[)}\]]+$/u, "");
}

function compactPreview(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

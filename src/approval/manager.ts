// 跨协程审批中枢:Human-in-the-loop 的人工审批管理器。
//
// 解决痛点:Agent 接入企业 IM 并操作远端服务器/生产数据库时,YOLO 模式下
// 会毫不犹豫执行 rm -rf 等不可逆高危命令。安全性绝不能依赖大模型"理智",
// 更不能寄希望于 System Prompt 那句"千万别删库"。
//
// 机制:Middleware 检测到高危操作 → 挂起当前执行流(返回挂起 Promise)→
// 通过通知通道(飞书/终端)发审批请求 → 人类回复 approve/reject →
// resolveApproval 唤醒对应 Promise → 同意则放行,拒绝则返回 Error 给大模型。
//
// 大模型甚至不知道自己被挂起了,只觉得这个 API 请求慢了一点。
//
// 【协程泄漏防护】评论区精华:用户既不确认也不拒绝 → Promise 永久挂起。
// 故 waitForApproval 内置超时(默认 30 分钟),超时自动判 Reject,
// 清理内存资源,防止挂死泄漏。

import { logger } from "../observability/logger.js";
import { isHardlineBashCommand } from "./bash-hardline.js";
import type { PermissionSessionScope } from "./session-permissions.js";

/** 审批结果包 */
export interface ApprovalResult {
  allowed: boolean;
  reason: string;
  /**
   * 用户"修改后通过"时携带的修改后内容(可选)。
   *
   * 三态语义:
   * - approve:allowed=true,modifiedContent=undefined
   * - reject:allowed=false,modifiedContent=undefined
   * - modify:allowed=true,modifiedContent=<新内容>
   *
   * 由 ExitPlanMode 等场景使用:审批通过且携带新内容时,调用方写回 PLAN.md 再放行。
   */
  modifiedContent?: string;
  /** 用户选择 Claude Code 风格的 session 级授权。 */
  allowForSession?: boolean;
}

/** 审批请求的通知信息(供通知通道发送给人类) */
export interface ApprovalPreview {
  target: string;
  summary: string;
  diff?: string;
  truncated?: boolean;
}

export interface ApprovalNotice {
  taskId: string;
  toolName: string;
  args: string;
  /** 对应 provider tool call；供 TUI 精确更新同一张工具卡。 */
  providerCallId?: string;
  message: string;
  /** 面向审批 UI/通知通道的极简预览信息。 */
  preview?: ApprovalPreview;
  /**
   * 工具执行前的 before/after diff 预览(可选)。
   * 由 computeApprovalDiff 在拦截时计算,供通知卡片展示具体改动。
   * 计算失败或工具不产生 diff 时为 undefined,审批照常进行。
   */
  diff?: string;
  /** 当前审批可应用的结构化 session 权限更新。 */
  sessionScope?: PermissionSessionScope;
}

/** 通知回调:由调用方注入(飞书发卡片 / 终端打印 / HTTP 推送) */
export type ApprovalNotifier = (notice: ApprovalNotice) => void;

interface PendingApproval {
  resolve: (result: ApprovalResult) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
  toolName: string;
  args: string;
  sessionScope?: PermissionSessionScope;
  signal?: AbortSignal;
  abortListener?: () => void;
}

/** 默认审批超时:30 分钟(超时自动 Reject,防协程泄漏) */
const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * ApprovalManager:统一管理当前正在等待人类审批的任务。
 *
 * 跨"执行流"与"回调流"的并发安全桥梁:
 * - 执行流(Middleware):调 waitForApproval 挂起等待
 * - 回调流(飞书 Webhook/终端输入):调 resolveApproval 唤醒
 *
 * Node 单线程无 Go 的 Goroutine,用 Promise + Map 实现等价的"挂起-唤醒"。
 */
export class ApprovalManager {
  /** TaskID → 挂起的 Promise resolver */
  private readonly pendingTasks = new Map<string, PendingApproval>();

  /** 默认超时(ms) */
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = DEFAULT_APPROVAL_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * 发送审批通知,并阻塞当前执行流等待回调结果。
   * @param diff 可选 before/after diff 预览,展示具体改动(向后兼容:不传也行)
   * @returns 审批结果(allowed + reason)
   */
  waitForApproval(
    taskId: string,
    toolName: string,
    args: string,
    notify: ApprovalNotifier,
    diff?: string,
    signal?: AbortSignal,
    options: { sessionScope?: PermissionSessionScope; providerCallId?: string } = {},
  ): Promise<ApprovalResult> {
    signal?.throwIfAborted();
    const message = `⚠ **高危操作审批请求**
Agent 试图执行以下动作:
- 工具: ${toolName}
- 参数: ${args}
任务 ID: **${taskId}**
👉 请回复 "approve ${taskId}" 同意放行,或 "reject ${taskId}" 拒绝执行。`;

    return new Promise<ApprovalResult>((resolve, reject) => {
      // 【协程泄漏防护】超时自动判 Reject,清理内存
      const timer = setTimeout(() => {
        const entry = this.takePendingTask(taskId);
        if (entry) {
          logger.warn(
            { taskId, timeoutMs: this.timeoutMs },
            `[Approval] 任务 ${taskId} 审批超时,自动拒绝。`,
          );
          entry.resolve({
            allowed: false,
            reason: `审批超时(${Math.floor(this.timeoutMs / 60000)} 分钟无人响应),系统自动拒绝。`,
          });
        }
      }, this.timeoutMs);

      const entry: PendingApproval = {
        resolve,
        reject,
        timer,
        toolName,
        args,
        ...(options.sessionScope ? { sessionScope: options.sessionScope } : {}),
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

      // 通过通知通道发送审批请求(diff 可选,计算失败时为 undefined)
      notify({
        taskId,
        toolName,
        args,
        ...(options.providerCallId !== undefined ? { providerCallId: options.providerCallId } : {}),
        message,
        preview: buildApprovalPreview(toolName, args, diff),
        ...(diff !== undefined ? { diff } : {}),
        ...(options.sessionScope ? { sessionScope: options.sessionScope } : {}),
      });
      logger.info({ taskId }, `[Approval] 已发送审批请求,执行流挂起等待...`);
    });
  }

  /**
   * 由审批回调(飞书 Webhook/终端输入)触发,唤醒挂起的执行流。
   */
  resolveApproval(taskId: string, allowed: boolean, reason: string): boolean {
    const entry = this.takePendingTask(taskId);
    if (!entry) {
      logger.warn({ taskId }, `[Approval] 找不到对应的 TaskID: ${taskId},可能已超时或处理完毕。`);
      return false;
    }
    logger.info(
      { taskId, allowed, reason },
      `[Approval] 收到审批结果 (TaskID: ${taskId}, Allowed: ${allowed}): ${reason}`,
    );
    entry.resolve({ allowed, reason });
    return true;
  }

  resolveApprovalForSession(taskId: string, reason: string): boolean {
    const entry = this.takePendingTask(taskId);
    if (!entry) {
      logger.warn({ taskId }, `[Approval] 找不到对应的 TaskID: ${taskId},可能已超时或处理完毕。`);
      return false;
    }
    entry.resolve({ allowed: true, reason, allowForSession: true });
    return true;
  }

  /**
   * "修改后通过"回调:唤醒挂起的执行流,携带用户修改后的内容。
   *
   * 用于 Plan Review 等场景:用户在审批时编辑了 PLAN.md 内容,选择"修改后通过"。
   * 此时 allowed=true(放行退出 Plan Mode),但 modifiedContent 非 undefined(写回后再放行)。
   */
  resolveApprovalWithModify(taskId: string, reason: string, modifiedContent: string): boolean {
    const entry = this.takePendingTask(taskId);
    if (!entry) {
      logger.warn({ taskId }, `[Approval] 找不到对应的 TaskID: ${taskId},可能已超时或处理完毕。`);
      return false;
    }
    logger.info(
      { taskId, reason, modified: true },
      `[Approval] 收到审批结果 (TaskID: ${taskId}, Modified): ${reason}`,
    );
    entry.resolve({ allowed: true, reason, modifiedContent });
    return true;
  }

  /** 取消单个挂起审批任务,用于 Permission Arbiter 失去竞速或外部中止时释放资源。 */
  cancelApproval(taskId: string, reason = "审批请求已取消。", abortReason?: unknown): boolean {
    const entry = this.takePendingTask(taskId);
    if (!entry) {
      return false;
    }
    logger.info({ taskId, reason }, `[Approval] 审批请求已取消 (TaskID: ${taskId}): ${reason}`);
    if (abortReason !== undefined) {
      entry.reject(abortReason);
    } else {
      entry.resolve({ allowed: false, reason });
    }
    return true;
  }

  private takePendingTask(taskId: string): PendingApproval | undefined {
    const entry = this.pendingTasks.get(taskId);
    if (!entry) return undefined;
    this.pendingTasks.delete(taskId);
    clearTimeout(entry.timer);
    if (entry.signal && entry.abortListener) {
      entry.signal.removeEventListener("abort", entry.abortListener);
    }
    return entry;
  }

  /** 当前挂起的审批任务数(测试/监控用) */
  get pendingCount(): number {
    return this.pendingTasks.size;
  }

  getPendingTask(
    taskId: string,
  ): { toolName: string; args: string; sessionScope?: PermissionSessionScope } | undefined {
    const task = this.pendingTasks.get(taskId);
    return task
      ? {
          toolName: task.toolName,
          args: task.args,
          ...(task.sessionScope ? { sessionScope: task.sessionScope } : {}),
        }
      : undefined;
  }

  /** 清理所有挂起任务(测试用) */
  clear(): void {
    for (const entry of this.pendingTasks.values()) {
      clearTimeout(entry.timer);
      if (entry.signal && entry.abortListener) {
        entry.signal.removeEventListener("abort", entry.abortListener);
      }
    }
    this.pendingTasks.clear();
  }
}

/**
 * 全局审批管理器单例。
 * Middleware 与飞书 Bot 回调之间通过它共享审批状态。
 */
export const globalApprovalManager = new ApprovalManager();

/**
 * 高危命令检测：普通危险操作使用保守正则，hardline Bash 使用结构化判定。
 * 纯读取工具默认 YOLO 放行;bash/write_file/edit_file 命中危险模式则需审批。
 *
 * 【架构师注】本实现为硬编码演示。生产环境应改造为支持外部配置
 * (.claw/permissions.yaml)+ 运行时热更新 (Hot-Reload) 的动态权限判定引擎,
 * 参考 Claude Code 的 allow/ask/deny 三态分类。
 *
 * 黑名单设计原则:宁可误拦(让用户审批),不可漏放(不可逆破坏)。
 * 覆盖所有已知删除/破坏/提权/覆盖变体。
 */
const DANGEROUS_PATTERNS: RegExp[] = [
  // 所有 rm 命令(删除即高危,无论单文件还是级联,宁可误拦)
  /\brm\b/i,
  // rmdir 删除目录
  /\brmdir\b/i,
  // find -delete / find -exec rm
  /\bfind\b.*(-delete|-exec\s+rm)/i,
  // unlink 删除文件
  /\bunlink\b/i,
  // sudo 提权
  /\bsudo\b/i,
  // 数据库删除/清表
  /\b(drop|truncate)\s+/i,
  // 格式化 / 磁盘镜像写入
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  // fork 炸弹
  /:\(\)\s*\{/,
  // 全权限开放
  /\bchmod\s+(-R\s+)?0?777\b/i,
  // 恶意覆盖源代码(bash 重定向 > file.ts)
  />\s*[^|]*\.(ts|js|go|py|rs|java|c|cpp|h)\s*$/i,
  // k8s 资源删除
  /\bkubectl\s+delete\b/i,
  // 强制推送覆盖远程
  /\bgit\s+push\s+(-f|--force)\b/i,
  // 杀进程
  /\bkill(all|-9)?\s+-?9?\b/i,
  // Nginx 服务重载/停止等运行态变更
  /\bnginx\s+-s\b/i,
  // systemd 服务管理
  /\bsystemctl\b/i,
  // 危险的 shell 写入覆盖系统文件
  /\bcat\s+.*\s*>\s*\/(etc|usr|bin|boot|sys|proc)\b/i,
];

const BASH_WRITE_REDIRECT_RE = /\d*>>?\s*(?!&)([^\s|;&]+)/u;
const BASH_WRITE_INTENT_PATTERNS: RegExp[] = [
  BASH_WRITE_REDIRECT_RE,
  /\btee\s+(-a\s+)?[^\s|;&]+/iu,
  /\bsed\s+(-i|--in-place)\b/iu,
  /\bperl\s+-pi\b/iu,
];

export function isDangerousCommand(toolName: string, args: string): boolean {
  // 纯读取工具默认 YOLO 模式,全部放行
  if (toolName !== "bash" && toolName !== "write_file" && toolName !== "edit_file") {
    return false;
  }

  // 对所有涉写工具检查参数是否命中危险模式
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(args)) {
      return true;
    }
  }
  return false;
}

export function isHardlineCommand(toolName: string, args: string): boolean {
  if (toolName !== "bash") return false;
  const command = parseBashCommand(args);
  // Bash 参数无法确定解析时不得继续到 shell。
  return command === undefined || isHardlineBashCommand(command);
}

function buildApprovalPreview(toolName: string, args: string, diff?: string): ApprovalPreview {
  const target = approvalPreviewTarget(toolName, args);
  const preview: ApprovalPreview = {
    target,
    summary: approvalPreviewSummary(toolName, target, args),
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
    if (command && findBashWriteRedirectTarget(command)) {
      return `bash 执行并写入 ${target}`;
    }
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
      if (typeof value === "string" && value.trim()) {
        return compactPreview(value.trim(), 160);
      }
    }
  }
  return compactPreview(args, 160);
}

function parseArgsObject(args: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(args);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseBashCommand(args: string): string | undefined {
  const parsed = parseArgsObject(args);
  const command = parsed?.["command"];
  return typeof command === "string" ? command : undefined;
}

function findBashWriteRedirectTarget(command: string): string | undefined {
  const match = command.match(BASH_WRITE_REDIRECT_RE);
  return match?.[1]?.replace(/[)}\]]+$/u, "");
}

function compactPreview(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/**
 * AgentOps 生产运维策略:
 * - 读操作继续 YOLO 放行
 * - 任意 write/edit 都必须审批
 * - bash 复用通用危险命令黑名单
 */
export function isAgentOpsDangerousCommand(toolName: string, args: string): boolean {
  if (toolName === "write_file" || toolName === "edit_file") {
    return true;
  }
  if (toolName === "bash") {
    const command = parseBashCommand(args);
    if (command && hasBashWriteIntent(command)) {
      return true;
    }
  }

  return isDangerousCommand(toolName, args);
}

function hasBashWriteIntent(command: string): boolean {
  return BASH_WRITE_INTENT_PATTERNS.some((pattern) => pattern.test(command));
}

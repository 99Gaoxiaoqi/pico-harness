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

/** 审批结果包 */
export interface ApprovalResult {
  allowed: boolean;
  reason: string;
}

/** 审批请求的通知信息(供通知通道发送给人类) */
export interface ApprovalNotice {
  taskId: string;
  toolName: string;
  args: string;
  message: string;
}

/** 通知回调:由调用方注入(飞书发卡片 / 终端打印 / HTTP 推送) */
export type ApprovalNotifier = (notice: ApprovalNotice) => void;

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
  private readonly pendingTasks = new Map<
    string,
    { resolve: (r: ApprovalResult) => void; timer: NodeJS.Timeout }
  >();

  /** 默认超时(ms) */
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = DEFAULT_APPROVAL_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * 发送审批通知,并阻塞当前执行流等待回调结果。
   * @returns 审批结果(allowed + reason)
   */
  waitForApproval(
    taskId: string,
    toolName: string,
    args: string,
    notify: ApprovalNotifier,
  ): Promise<ApprovalResult> {
    const message = `⚠ **高危操作审批请求**
Agent 试图执行以下动作:
- 工具: ${toolName}
- 参数: ${args}
任务 ID: **${taskId}**
👉 请回复 "approve ${taskId}" 同意放行,或 "reject ${taskId}" 拒绝执行。`;

    return new Promise<ApprovalResult>((resolve) => {
      // 【协程泄漏防护】超时自动判 Reject,清理内存
      const timer = setTimeout(() => {
        if (this.pendingTasks.has(taskId)) {
          this.pendingTasks.delete(taskId);
          console.warn(
            `[Approval] 任务 ${taskId} 审批超时(${this.timeoutMs}ms),自动拒绝。`,
          );
          resolve({
            allowed: false,
            reason: `审批超时(${Math.floor(this.timeoutMs / 60000)} 分钟无人响应),系统自动拒绝。`,
          });
        }
      }, this.timeoutMs);

      this.pendingTasks.set(taskId, { resolve, timer });

      // 通过通知通道发送审批请求
      notify({ taskId, toolName, args, message });
      console.log(`[Approval] 已发送审批请求 (TaskID: ${taskId}),执行流挂起等待...`);
    });
  }

  /**
   * 由审批回调(飞书 Webhook/终端输入)触发,唤醒挂起的执行流。
   */
  resolveApproval(taskId: string, allowed: boolean, reason: string): boolean {
    const entry = this.pendingTasks.get(taskId);
    if (!entry) {
      console.warn(`[Approval] 找不到对应的 TaskID: ${taskId},可能已超时或处理完毕。`);
      return false;
    }
    clearTimeout(entry.timer);
    this.pendingTasks.delete(taskId);
    console.log(
      `[Approval] 收到审批结果 (TaskID: ${taskId}, Allowed: ${allowed}): ${reason}`,
    );
    entry.resolve({ allowed, reason });
    return true;
  }

  /** 当前挂起的审批任务数(测试/监控用) */
  get pendingCount(): number {
    return this.pendingTasks.size;
  }

  /** 清理所有挂起任务(测试用) */
  clear(): void {
    for (const { timer } of this.pendingTasks.values()) {
      clearTimeout(timer);
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
 * 高危命令检测:正则黑名单。
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
  // 危险的 shell 写入覆盖系统文件
  /\bcat\s+.*\s*>\s*\/(etc|usr|bin|boot|sys|proc)\b/i,
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

import {
  isActiveRunStatus,
  isInterruptedRunStatus,
  isStreamingRunStatus,
  isTerminalRunStatus,
  type RuntimeNotification,
  type RuntimeNotificationMap,
  type RuntimeRun,
} from "@pico/protocol";
import type { TuiReporter } from "./tui-reporter.js";

/**
 * daemon 通知 → TuiReporter 回调适配器（3-D Phase 2 核心）。
 *
 * Transcript/live 已由 Dedicated Session Channel 与共享 Replica 承载；
 * 本适配器只处理工作区 durable 通知、运行相位和交互请求。
 */

export interface DaemonEventReporterOptions {
  readonly reporter: TuiReporter;
  /** 审批请求透传（client-session-runtime 持 pending map 并驱动对话框）。 */
  readonly onApprovalRequested?: (
    payload: RuntimeNotificationMap["approval.requested"],
    scope: { workspacePath: string; runId?: string; sessionId?: string },
  ) => void;
  /** ask-user 问题到达（payload.prompt 含 question/options/freeText；对话框由宿主开）。 */
  readonly onPromptRequested?: (
    payload: RuntimeNotificationMap["prompt.requested"],
    scope: { workspacePath: string; runId?: string; sessionId?: string },
  ) => void;
  /** 运行相位变化（run.started/finished）透传，驱动 running 状态与中断可用性。 */
  readonly onRunStateChanged?: (running: boolean) => void;
}

export class DaemonEventReporter {
  private readonly reporter: TuiReporter;
  private readonly onApprovalRequested: DaemonEventReporterOptions["onApprovalRequested"];
  private readonly onPromptRequested: DaemonEventReporterOptions["onPromptRequested"];
  private readonly onRunStateChanged: DaemonEventReporterOptions["onRunStateChanged"];
  private active = false;
  private currentRunId: string | undefined;

  constructor(options: DaemonEventReporterOptions) {
    this.reporter = options.reporter;
    this.onApprovalRequested = options.onApprovalRequested;
    this.onPromptRequested = options.onPromptRequested;
    this.onRunStateChanged = options.onRunStateChanged;
  }

  get running(): boolean {
    return this.active;
  }

  /** 当前活跃 run（run.started 记录，终态清除）——run.cancel 的目标。 */
  get activeRunId(): string | undefined {
    return this.active ? this.currentRunId : undefined;
  }

  /** 会话切换（/resume /fork /new）时清空上一会话的瞬时 run 跟踪。 */
  clearTransientState(): void {
    this.active = false;
    this.currentRunId = undefined;
  }

  /**
   * 从 transcript.activeRun 恢复运行相位（水化后调用——/resume 进运行中会话
   * 时 run.started 已错过，事件流不会再补）。幂等：已活跃时不重复触发回调。
   */
  seedActiveRun(runId: string): void {
    // Hydration 只能补齐缺失的 live 事实，不能覆盖已经由
    // run.started 观测到的更新 run。重连时 open 快照可能落后于通知流。
    if (this.active) return;
    this.active = true;
    this.currentRunId = runId;
    this.onRunStateChanged?.(true);
  }

  /** 对账一条带身份的 Replica run 快照；终态只能收口同一 run。 */
  reconcileRunSnapshot(run: RuntimeRun): void {
    if (isActiveRunStatus(run.status)) {
      this.seedActiveRun(run.runId);
      return;
    }
    if (isTerminalRunStatus(run.status)) this.finishMatchingRun(run.runId, run.status);
  }

  handleNotification(event: RuntimeNotification): void {
    const payload = event.payload as Record<string, unknown>;
    switch (event.topic) {
      case "run.started":
      case "run.updated": {
        const run = payload["run"] as { runId?: unknown; status?: unknown } | undefined;
        const runId = typeof run?.runId === "string" ? run.runId : undefined;
        const status = typeof run?.status === "string" ? run.status : "";
        const running = isStreamingRunStatus(status);
        if (event.topic === "run.started" && running) {
          // 重叠 run（排队链：A 活跃中 B 已 started）跟踪最新 runId——/interrupt
          // 才打对目标（对抗评审 P2：此前忽略导致 B 全程失跟踪）。
          if (!this.active) {
            this.active = true;
            this.reporter.onStart(event.scope.workspacePath);
            this.onRunStateChanged?.(true);
          }
          this.currentRunId = runId;
        } else if (!running && isTerminalRunStatus(status)) {
          if (this.finishMatchingRun(runId ?? event.scope.runId, status)) {
            this.surfaceRunFailure(run);
          }
        }
        // paused/cancelling：非终态非运行——保持 active（run 仍占用，spinner 继续
        // 是可接受近似；终态由 run.finished 收口）。
        return;
      }
      case "run.finished": {
        const run = payload["run"] as
          | { runId?: unknown; status?: unknown; error?: unknown }
          | undefined;
        const runId = typeof run?.runId === "string" ? run.runId : event.scope.runId;
        if (
          this.finishMatchingRun(runId, typeof run?.status === "string" ? run.status : "succeeded")
        ) {
          this.surfaceRunFailure(run);
        }
        return;
      }
      case "runtime.error": {
        // daemon 级运行时错误（会话装配/资源失败）——此前无消费者，界面静默。
        const message = typeof payload["message"] === "string" ? payload["message"] : "";
        if (message) {
          this.reporter.pushError(message, { retryable: payload["recoverable"] === true });
        }
        return;
      }
      case "approval.requested":
        this.onApprovalRequested?.(payload as RuntimeNotificationMap["approval.requested"], {
          workspacePath: event.scope.workspacePath,
          ...(event.scope.runId ? { runId: event.scope.runId } : {}),
          ...(event.scope.sessionId ? { sessionId: event.scope.sessionId } : {}),
        });
        return;
      case "prompt.requested":
        this.onPromptRequested?.(payload as RuntimeNotificationMap["prompt.requested"], {
          workspacePath: event.scope.workspacePath,
          ...(event.scope.runId ? { runId: event.scope.runId } : {}),
          ...(event.scope.sessionId ? { sessionId: event.scope.sessionId } : {}),
        });
        return;
      default:
        return;
    }
  }

  private finishMatchingRun(runId: string | undefined, status: string): boolean {
    if (!this.active || !runId || runId !== this.currentRunId) return false;
    this.finishRun(status);
    return true;
  }

  private finishRun(status: string): void {
    this.active = false;
    this.currentRunId = undefined;
    if (isInterruptedRunStatus(status)) {
      this.reporter.onInterrupted();
    } else {
      this.reporter.onFinish();
    }
    this.onRunStateChanged?.(false);
  }

  /**
   * run 以 failed 收口时把错误文本推成可见条目（错误可见性收口，2026-08-17）。
   * 此前 failed 归入 onInterrupted，payload.run.error 被丢弃——provider 失败
   * （端点不可达/key 缺失/模型报错）在界面上静默无显示。水化重取后该 live
   * 条目由持久 run-boundary(failed) 渲染接替（message-row），不重复。
   */
  private surfaceRunFailure(run: { status?: unknown; error?: unknown } | undefined): void {
    const error = typeof run?.error === "string" ? run.error : "";
    if (run?.status === "failed" && error) {
      this.reporter.pushError(error, { retryable: true });
    }
  }
}

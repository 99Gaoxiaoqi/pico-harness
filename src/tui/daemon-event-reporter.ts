import { createHash } from "node:crypto";
import type { RuntimeNotification, RuntimeNotificationMap } from "@pico/protocol";
import type { ToolResultEnvelope } from "../engine/tool-result-contract.js";
import type { TuiReporter } from "./tui-reporter.js";

/**
 * daemon 通知 → TuiReporter 回调适配器（3-D Phase 2 核心）。
 *
 * 策略与 Desktop renderer 同构：run.live 只做"即时增量"（append），终态不落定
 * （complete/clear 忽略），权威文本/工具结果由 `session.transcriptUpdated{reload}`
 * 触发 transcript 重取对账修复（重连丢流同理）。run.live 的 tool/subagent kind
 * 是 3-D Phase 1 新增的实时通道，这里直接映射回 TuiReporter 的工具卡/子代理
 * 卡回调——TuiReporter 的 TranscriptEventStore 投影零改动复用。
 */

export interface DaemonEventReporterOptions {
  readonly reporter: TuiReporter;
  /** 审批请求透传（client-session-runtime 持 pending map 并驱动对话框）。 */
  readonly onApprovalRequested?: (
    payload: RuntimeNotificationMap["approval.requested"],
    scope: { workspacePath: string; runId?: string; sessionId?: string },
  ) => void;
  /** 运行相位变化（run.started/finished）透传，驱动 running 状态与中断可用性。 */
  readonly onRunStateChanged?: (running: boolean) => void;
}

export class DaemonEventReporter {
  private readonly reporter: TuiReporter;
  private readonly onApprovalRequested: DaemonEventReporterOptions["onApprovalRequested"];
  private readonly onRunStateChanged: DaemonEventReporterOptions["onRunStateChanged"];
  private active = false;
  private currentRunId: string | undefined;

  constructor(options: DaemonEventReporterOptions) {
    this.reporter = options.reporter;
    this.onApprovalRequested = options.onApprovalRequested;
    this.onRunStateChanged = options.onRunStateChanged;
  }

  get running(): boolean {
    return this.active;
  }

  /** 当前活跃 run（run.started 记录，终态清除）——run.cancel 的目标。 */
  get activeRunId(): string | undefined {
    return this.active ? this.currentRunId : undefined;
  }

  handleNotification(event: RuntimeNotification): void {
    const payload = event.payload as Record<string, unknown>;
    switch (event.topic) {
      case "run.started":
      case "run.updated": {
        const run = payload["run"] as { runId?: unknown; status?: unknown } | undefined;
        const runId = typeof run?.runId === "string" ? run.runId : undefined;
        const status = typeof run?.status === "string" ? run.status : "";
        const running = status === "queued" || status === "running" || status === "pause_requested";
        if (event.topic === "run.started" && running && !this.active) {
          this.active = true;
          this.currentRunId = runId;
          this.reporter.onStart(event.scope.workspacePath);
          this.onRunStateChanged?.(true);
        } else if (this.active && !running && this.isTerminalStatus(status)) {
          this.finishRun(status);
        }
        return;
      }
      case "run.finished": {
        const run = payload["run"] as { status?: unknown } | undefined;
        if (this.active) this.finishRun(typeof run?.status === "string" ? run.status : "succeeded");
        return;
      }
      case "run.live":
        this.handleLiveItem(payload);
        return;
      case "approval.requested":
        this.onApprovalRequested?.(
          payload as RuntimeNotificationMap["approval.requested"],
          {
            workspacePath: event.scope.workspacePath,
            ...(event.scope.runId ? { runId: event.scope.runId } : {}),
            ...(event.scope.sessionId ? { sessionId: event.scope.sessionId } : {}),
          },
        );
        return;
      default:
        return;
    }
  }

  private finishRun(status: string): void {
    this.active = false;
    this.currentRunId = undefined;
    if (status === "cancelled" || status === "interrupted") {
      this.reporter.onInterrupted();
    } else {
      this.reporter.onFinish();
    }
    this.onRunStateChanged?.(false);
  }

  private isTerminalStatus(status: string): boolean {
    return (
      status === "succeeded" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "interrupted"
    );
  }

  private handleLiveItem(payload: Record<string, unknown>): void {
    const item = payload["item"] as Record<string, unknown> | undefined;
    if (!item) return;
    const kind = item["kind"];
    const operation = item["operation"];
    const delta = typeof item["delta"] === "string" ? item["delta"] : "";
    if (kind === "thinking" || kind === "assistantMessage") {
      // 只消费 append；complete/clear 不落定——由 transcriptUpdated 对账修复终态。
      if (operation === "append" && delta) {
        if (kind === "thinking") this.reporter.onReasoningDelta(delta);
        else this.reporter.onTextDelta(delta);
      }
      return;
    }
    if (kind === "tool") {
      const toolCallId = typeof item["toolCallId"] === "string" ? item["toolCallId"] : "";
      const toolName = typeof item["toolName"] === "string" ? item["toolName"] : "";
      if (!toolCallId || !toolName) return;
      if (operation === "started") {
        const args = typeof item["args"] === "string" ? item["args"] : "";
        this.reporter.onToolCall(toolName, args, toolCallId);
        return;
      }
      if (operation === "append") {
        if (delta) {
          const stream = item["stream"] === "stderr" ? "stderr" : "stdout";
          this.reporter.onToolOutput(toolName, stream, delta, toolCallId);
        }
        return;
      }
      if (operation === "completed" || operation === "failed") {
        this.reporter.onToolResult(
          syntheticToolResultEnvelope(
            toolCallId,
            toolName,
            operation === "completed" ? "succeeded" : "failed",
            typeof item["summary"] === "string" ? item["summary"] : "",
            item["truncated"] === true,
          ),
        );
      }
      return;
    }
    if (kind === "subagent") {
      const activityId = typeof item["activityId"] === "string" ? item["activityId"] : "";
      const status = typeof item["status"] === "string" ? item["status"] : "running";
      if (!activityId) return;
      this.reporter.onSubagentActivity({
        activityId,
        task: typeof item["task"] === "string" ? item["task"] : "",
        status: status as never,
        ...(item["agentName"] !== undefined && typeof item["agentName"] === "string"
          ? { agentName: item["agentName"] }
          : {}),
        mode: item["mode"] === "explore" ? "explore" : "worker",
        completionPolicy: "required",
        ...(typeof item["currentAction"] === "string"
          ? { currentAction: item["currentAction"] }
          : {}),
        ...(typeof item["summary"] === "string" ? { summary: item["summary"] } : {}),
      });
    }
    // 未知 kind：静默忽略（wire 前向兼容契约）。
  }
}

/**
 * live 工具完成事件没有 canonical envelope——用 summary 文本合成有界投影，
 * 与 TuiReporter.onInterrupted 的合成模式同款；权威结果由 transcript 对账覆盖。
 */
function syntheticToolResultEnvelope(
  toolCallId: string,
  toolName: string,
  status: "succeeded" | "failed",
  summary: string,
  truncated: boolean,
): ToolResultEnvelope {
  return {
    version: 1,
    toolCallId,
    toolName,
    status,
    rawSizeBytes: Buffer.byteLength(summary, "utf8"),
    sha256: createHash("sha256").update(summary, "utf8").digest("hex"),
    projection: {
      version: 1,
      mode: "synthetic",
      text: summary,
      strategy: "run-live",
      truncated,
    },
    deliveryTruncated: false,
  };
}

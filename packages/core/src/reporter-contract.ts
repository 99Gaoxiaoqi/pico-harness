import type { ToolResultEnvelope } from "./tool-result.js";
import type { CanonicalTranscriptToolStart } from "./transcript-tool-start.js";
import type { ModelCommunicationCategory, ModelResponseDiagnostic } from "./provider-errors.js";

export type SubagentActivityStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "timed_out"
  | "cancelled";

export type AssistantResponseSuppressionReason = "internal-control" | "network-retry";

/** Safe, bounded model retry progress. Never carries remote error text or request content. */
export interface ProviderRetryNotice {
  readonly phase: "scheduled" | "started";
  readonly failedAttempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly failureStatus: "timed_out" | "cancelled" | "error";
  readonly errorCategory?: ModelCommunicationCategory;
  readonly httpStatus?: number;
  readonly transportCode?: ModelResponseDiagnostic["transportCode"];
  readonly diagnosticId?: string;
}

/** 宿主可见的子代理活动快照；activityId 只用于更新同一张卡片。 */
export interface SubagentActivityEvent {
  childSessionId?: string;
  childWorkspacePath?: string;
  toolCallId?: string;
  durationMs?: number;
  activityId: string;
  task: string;
  status: SubagentActivityStatus;
  agentName?: string;
  mode: "explore" | "worker";
  completionPolicy: "required" | "optional" | "detached";
  currentAction?: string;
  summary?: string;
  requestedModelRoute?: string;
  resolvedModelRoute?: string;
  thinkingEffort?: string;
  modelSelectionSource?: "ephemeral" | "profile" | "parent";
}

/** 子代理详情轨迹；traceId 在单个 activity 内稳定，工具完成事件用它更新原条目。 */
export type SubagentTraceEvent =
  | { activityId: string; traceId: string; type: "thinking" }
  | { activityId: string; traceId: string; type: "message"; content: string }
  | {
      activityId: string;
      traceId: string;
      type: "tool.started";
      name: string;
      args: string;
    }
  | {
      activityId: string;
      traceId: string;
      type: "tool.completed";
      result: ToolResultEnvelope;
    };

/** Agent 执行内核向任意宿主投影运行生命周期的端口。 */
export interface Reporter {
  onThinking(): void;
  onThinkingEnd?(): void;
  onToolCall(
    toolName: string,
    args: string,
    providerCallId: string,
    durableStart?: CanonicalTranscriptToolStart,
  ): void;
  onToolResult(result: ToolResultEnvelope): void;
  onToolOutput?(
    toolName: string,
    stream: "stdout" | "stderr",
    chunk: string,
    providerCallId: string,
  ): void;
  onSubagentActivity?(activity: SubagentActivityEvent): void;
  onSubagentActivitiesClaimed?(activityIds: readonly string[]): void;
  onSubagentTrace?(event: SubagentTraceEvent): void;
  onSubagentModelResolved?(model: {
    requestedModelRoute?: string;
    resolvedModelRoute: string;
    thinkingEffort?: string;
    source: "ephemeral" | "profile" | "parent";
  }): void;
  onMessage(content: string): void;
  onStart(workDir: string): void;
  onTurnStart(turn: number): void;
  onFinish(): void;
  onInterrupted?(): void;
  onTextDelta?(delta: string): void;
  onReasoningDelta?(delta: string): void;
  onAssistantResponseSuppressed?(reason: AssistantResponseSuppressionReason): void;
  onProviderRetry?(notice: ProviderRetryNotice): void;
}

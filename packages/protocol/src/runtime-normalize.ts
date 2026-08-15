/**
 * wire 归一化谓词与解析（3-D Phase 3：Desktop renderer 与 TUI 客户端收敛）。
 *
 * 此前终态判定四套实现两处分叉（Desktop 含非枚举值 "completed"、TUI 正向
 * 集合口径不一），审批 payload 两侧手工平行读取（TUI 修正的 planId 兜底
 * 语义未回流 Desktop）。本模块是唯一来源：枚举本源 RuntimeRunStatus 在
 * runtime.ts，视图层各自映射，判定/读取不再复制。
 *
 * 两个"活跃"口径语义不同、各自命名不复用：
 * - isActiveRunStatus：水化/对账口径（paused/cancelling 算活跃——run 仍占用
 *   会话，/resume 进暂停会话须恢复运行相位）。
 * - isStreamingRunStatus：流式相位灯口径（paused 不在流，灯不亮）。
 */

const TERMINAL_RUN_STATUSES: readonly string[] = ["cancelled", "failed", "succeeded"];
const ACTIVE_RUN_STATUSES: readonly string[] = [
  "queued",
  "running",
  "pause_requested",
  "paused",
  "cancelling",
];
const STREAMING_RUN_STATUSES: readonly string[] = ["queued", "running", "pause_requested"];

/** 终态（run 收尾）：cancelled | failed | succeeded。其余值（含未知字符串）一律非终态。 */
export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/** 水化/对账口径的活跃 run（含 paused/cancelling——run 未收尾即占用会话）。 */
export function isActiveRunStatus(status: string): boolean {
  return ACTIVE_RUN_STATUSES.includes(status);
}

/** 流式相位灯口径（paused 不在流）。与 isActiveRunStatus 语义不同，勿混用。 */
export function isStreamingRunStatus(status: string): boolean {
  return STREAMING_RUN_STATUSES.includes(status);
}

/** run.live 的 onInterrupted 分支（cancelled/failed）；succeeded 走 onFinish。 */
export function isInterruptedRunStatus(status: string): boolean {
  return status === "cancelled" || status === "failed";
}

/** approval.requested payload 的结构化读取（两侧视图各自映射，wire 语义一处收口）。 */
export interface ApprovalRequestedView {
  readonly approvalId: string;
  /** payload.runId（protocol 类型必填；缺失时调用方按 scope 兜底）。 */
  readonly runId?: string;
  readonly kind: "tool" | "plan";
  readonly title?: string;
  /** request.detail ?? request.description（wire 两名并存）。 */
  readonly detail?: string;
  readonly command?: string;
  readonly risk: "low" | "medium" | "high";
  readonly toolName?: string;
  readonly args?: string;
  readonly providerCallId?: string;
  /** request.planId ?? request.plan.planId——都未带则 undefined（不回退 approvalId，回退会构造 bogus plan.respond）。 */
  readonly planId?: string;
  /** request.expectedRevision ?? request.plan.revision。 */
  readonly expectedRevision?: number;
  readonly expectedSessionSequence?: number;
  readonly planTitle?: string;
  readonly planOverview?: string;
  readonly planSteps?: readonly string[];
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 解析 approval.requested 事件 payload（开放 JsonObject 的严格读取）。缺
 * approvalId 视为 malformed 返回 undefined——调用方按不可渲染丢弃；runId
 * 缺失不致命（调用方按事件 scope 兜底）。
 */
export function parseApprovalRequestedPayload(payload: unknown): ApprovalRequestedView | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const approvalId = stringOrUndefined(record["approvalId"]);
  if (!approvalId) return undefined;
  const runId = stringOrUndefined(record["runId"]);
  const request =
    typeof record["request"] === "object" && record["request"] !== null
      ? (record["request"] as Record<string, unknown>)
      : {};
  const plan =
    typeof request["plan"] === "object" && request["plan"] !== null
      ? (request["plan"] as Record<string, unknown>)
      : {};
  const steps = Array.isArray(plan["steps"])
    ? plan["steps"]
        .map((step) =>
          typeof step === "object" && step !== null
            ? stringOrUndefined((step as Record<string, unknown>)["title"]) ??
              stringOrUndefined((step as Record<string, unknown>)["description"])
            : undefined,
        )
        .filter((step): step is string => step !== undefined)
    : undefined;
  return {
    approvalId,
    ...(runId ? { runId } : {}),
    kind: request["kind"] === "plan" ? "plan" : "tool",
    title: stringOrUndefined(request["title"]),
    detail: stringOrUndefined(request["detail"]) ?? stringOrUndefined(request["description"]),
    command: stringOrUndefined(request["command"]),
    risk: request["risk"] === "high" || request["risk"] === "medium" ? request["risk"] : "low",
    toolName: stringOrUndefined(request["toolName"]),
    args: stringOrUndefined(request["args"]),
    providerCallId: stringOrUndefined(request["providerCallId"]),
    planId: stringOrUndefined(request["planId"]) ?? stringOrUndefined(plan["planId"]),
    expectedRevision:
      numberOrUndefined(request["expectedRevision"]) ?? numberOrUndefined(plan["revision"]),
    expectedSessionSequence: numberOrUndefined(request["expectedSessionSequence"]),
    planTitle: stringOrUndefined(plan["title"]),
    planOverview: stringOrUndefined(plan["overview"]),
    ...(steps && steps.length > 0 ? { planSteps: steps } : {}),
  };
}

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

/** 运行态投影的中断分支（cancelled/failed）；succeeded 走正常完成。 */
export function isInterruptedRunStatus(status: string): boolean {
  return status === "cancelled" || status === "failed";
}

interface ApprovalRequestedBaseView {
  readonly approvalId: string;
  readonly runId: string;
  readonly title: string;
  readonly detail: string;
  readonly risk: "low" | "medium" | "high";
}

export interface ToolApprovalRequestedView extends ApprovalRequestedBaseView {
  readonly kind: "tool";
  readonly toolName: string;
  readonly args: string;
  readonly providerCallId: string;
  readonly command?: string;
  /** request.diff——引擎 computeApprovalDiff 的 before/after 预览（bash 等无 diff 工具为 undefined）。 */
  readonly diff?: string;
  /** request.sessionScope——"本会话内允许"的结构化授权形状；缺失=审批面板只渲染 2 选项。 */
  readonly sessionScope?: ApprovalSessionScopeView;
  readonly planId?: never;
  readonly expectedRevision?: never;
  readonly expectedSessionSequence?: never;
  readonly controlEpoch?: never;
  readonly operationId?: never;
  readonly planTitle?: never;
  readonly planOverview?: never;
  readonly planSteps?: never;
}

export interface PlanApprovalRequestedView extends ApprovalRequestedBaseView {
  readonly kind: "plan";
  readonly planId: string;
  readonly expectedRevision: number;
  readonly expectedSessionSequence: number;
  readonly controlEpoch: string;
  readonly operationId: string;
  readonly planTitle: string;
  readonly planOverview?: string;
  readonly planSteps: readonly string[];
  readonly toolName?: never;
  readonly args?: never;
  readonly providerCallId?: never;
  readonly command?: never;
  readonly diff?: never;
  readonly sessionScope?: never;
}

/** Current approval.requested is a strict discriminated tool/Plan wire contract. */
export type ApprovalRequestedView = ToolApprovalRequestedView | PlanApprovalRequestedView;

/**
 * PermissionSessionScope 的 wire 投影（结构对齐 src/approval/session-permissions.ts；
 * 协议包不 import 引擎源码，两侧字段语义由 parseApprovalRequestedPayload 测试锚定）。
 */
export type ApprovalSessionScopeView =
  | { readonly type: "network" }
  | { readonly type: "all-edits" }
  | {
      readonly type: "directories";
      readonly directories: readonly string[];
      readonly access: "read" | "edit";
      readonly enableAutoEdits: boolean;
    }
  | {
      readonly type: "file";
      readonly path: string;
      readonly access: "read" | "edit";
      readonly safety?: boolean;
    }
  | {
      readonly type: "bash-command";
      readonly command: string;
      readonly match: "prefix" | "exact";
      readonly safety?: boolean;
    }
  | { readonly type: "tool"; readonly toolName: string };

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

/**
 * 解析 current approval.requested payload。任何缺字段、别名、分支混用或
 * malformed session scope 均整体拒绝，调用方不得构造可执行卡片。
 */
export function parseApprovalRequestedPayload(payload: unknown): ApprovalRequestedView | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const approvalId = stringOrUndefined(record["approvalId"]);
  const runId = stringOrUndefined(record["runId"]);
  if (!approvalId || !runId || !exactKeys(record, ["approvalId", "runId", "request"])) {
    return undefined;
  }
  if (typeof record["request"] !== "object" || record["request"] === null) return undefined;
  const request = record["request"] as Record<string, unknown>;
  const title = stringOrUndefined(request["title"]);
  const detail = stringOrUndefined(request["detail"]);
  const risk =
    request["risk"] === "low" || request["risk"] === "medium" || request["risk"] === "high"
      ? request["risk"]
      : undefined;
  if (!title || !detail || !risk) return undefined;

  if (request["kind"] === "tool") {
    const allowed = [
      "kind",
      "title",
      "detail",
      "risk",
      "toolName",
      "args",
      "providerCallId",
      ...(request["command"] === undefined ? [] : ["command"]),
      ...(request["diff"] === undefined ? [] : ["diff"]),
      ...(request["sessionScope"] === undefined ? [] : ["sessionScope"]),
    ];
    const toolName = stringOrUndefined(request["toolName"]);
    const providerCallId = stringOrUndefined(request["providerCallId"]);
    if (
      !exactKeys(request, allowed) ||
      !toolName ||
      typeof request["args"] !== "string" ||
      !providerCallId ||
      (request["command"] !== undefined && !stringOrUndefined(request["command"])) ||
      (request["diff"] !== undefined && typeof request["diff"] !== "string")
    ) {
      return undefined;
    }
    const sessionScope = parseApprovalSessionScope(request["sessionScope"]);
    if (request["sessionScope"] !== undefined && !sessionScope) return undefined;
    return {
      approvalId,
      runId,
      kind: "tool",
      title,
      detail,
      risk,
      toolName,
      args: request["args"],
      providerCallId,
      ...(stringOrUndefined(request["command"]) ? { command: request["command"] as string } : {}),
      ...(typeof request["diff"] === "string" ? { diff: request["diff"] } : {}),
      ...(sessionScope ? { sessionScope } : {}),
    };
  }

  if (request["kind"] !== "plan") return undefined;
  if (
    !exactKeys(request, [
      "kind",
      "title",
      "detail",
      "risk",
      "planId",
      "expectedRevision",
      "expectedSessionSequence",
      "controlEpoch",
      "operationId",
      "plan",
    ])
  ) {
    return undefined;
  }
  const planId = stringOrUndefined(request["planId"]);
  const controlEpoch = stringOrUndefined(request["controlEpoch"]);
  const operationId = stringOrUndefined(request["operationId"]);
  const expectedRevision = request["expectedRevision"];
  const expectedSessionSequence = request["expectedSessionSequence"];
  if (
    !planId ||
    !controlEpoch ||
    !operationId ||
    !Number.isSafeInteger(expectedRevision) ||
    (expectedRevision as number) < 1 ||
    !Number.isSafeInteger(expectedSessionSequence) ||
    (expectedSessionSequence as number) < 0 ||
    typeof request["plan"] !== "object" ||
    request["plan"] === null
  ) {
    return undefined;
  }
  const plan = request["plan"] as Record<string, unknown>;
  const planTitle = stringOrUndefined(plan["title"]);
  if (
    plan["planId"] !== planId ||
    plan["revision"] !== expectedRevision ||
    !planTitle ||
    !Array.isArray(plan["steps"]) ||
    plan["steps"].length === 0
  ) {
    return undefined;
  }
  const planSteps = plan["steps"].map((step) => {
    if (typeof step !== "object" || step === null) return undefined;
    return stringOrUndefined((step as Record<string, unknown>)["title"]);
  });
  if (planSteps.some((step) => step === undefined)) return undefined;
  const planOverview = stringOrUndefined(plan["overview"]);
  return {
    approvalId,
    runId,
    kind: "plan",
    title,
    detail,
    risk,
    planId,
    expectedRevision: expectedRevision as number,
    expectedSessionSequence: expectedSessionSequence as number,
    controlEpoch,
    operationId,
    planTitle,
    ...(planOverview ? { planOverview } : {}),
    planSteps: planSteps as string[],
  };
}

/**
 * request.sessionScope 的严格解析：形状不完整/未知 type 一律 undefined
 * （调用方降级为 2 选项面板，绝不猜形状构造授权描述）。
 */
export function parseApprovalSessionScope(value: unknown): ApprovalSessionScopeView | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const access =
    record["access"] === "edit" ? "edit" : record["access"] === "read" ? "read" : undefined;
  const safety = typeof record["safety"] === "boolean" ? record["safety"] : undefined;
  if (record["safety"] !== undefined && safety === undefined) return undefined;
  switch (record["type"]) {
    case "network":
      return exactKeys(record, ["type"]) ? { type: "network" } : undefined;
    case "all-edits":
      return exactKeys(record, ["type"]) ? { type: "all-edits" } : undefined;
    case "directories": {
      if (!exactKeys(record, ["type", "directories", "access", "enableAutoEdits"]) || !access) {
        return undefined;
      }
      const directories = record["directories"];
      if (
        !Array.isArray(directories) ||
        directories.length === 0 ||
        !directories.every((item): item is string => typeof item === "string" && item !== "")
      ) {
        return undefined;
      }
      if (typeof record["enableAutoEdits"] !== "boolean") return undefined;
      return {
        type: "directories",
        directories,
        access,
        enableAutoEdits: record["enableAutoEdits"],
      };
    }
    case "file": {
      if (
        !exactKeys(record, ["type", "path", "access", ...(safety === undefined ? [] : ["safety"])])
      ) {
        return undefined;
      }
      const path = stringOrUndefined(record["path"]);
      if (!path || !access) return undefined;
      return safety === undefined
        ? { type: "file", path, access }
        : { type: "file", path, access, safety };
    }
    case "bash-command": {
      if (
        !exactKeys(record, [
          "type",
          "command",
          "match",
          ...(safety === undefined ? [] : ["safety"]),
        ])
      ) {
        return undefined;
      }
      const command = stringOrUndefined(record["command"]);
      const match =
        record["match"] === "prefix" || record["match"] === "exact" ? record["match"] : undefined;
      if (!command || !match) return undefined;
      return safety === undefined
        ? { type: "bash-command", command, match }
        : { type: "bash-command", command, match, safety };
    }
    case "tool": {
      if (!exactKeys(record, ["type", "toolName"])) return undefined;
      const toolName = stringOrUndefined(record["toolName"]);
      if (!toolName) return undefined;
      return { type: "tool", toolName };
    }
    default:
      return undefined;
  }
}

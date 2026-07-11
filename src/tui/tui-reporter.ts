// TUI Reporter:把 Agent 引擎的事件流转成 React 可渲染的状态(对标 Claude Code ink 架构)。
//
// 设计:Reporter 接口是 engine 与 I/O 的解耦点(reporter.ts)。
// 本类把 engine 回调追加为不可变事件，再由纯 reducer 投影为现有
// entries 快照。onUpdate 由 ink 的 <App> 组件注册为 setState。
//
// 状态机:TUI EventStore 维护 append-only 日志，投影层生成对话流:
//   - user 消息(由 repl 主动 push,非 reporter 回调)
//   - assistant 流式输出(onTextDelta 累积)
//   - 工具调用卡片(onToolCall → onToolResult 配对)
//   - 思考中 spinner(onThinking)
//
// 不直接渲染 ink 组件(保持 reporter 纯数据层),渲染由 App.tsx 消费 state 完成。

import type { Reporter } from "../engine/reporter.js";
import { formatOutputPreview } from "./diff-preview.js";
import type { ToolCardStatus } from "./tool-card.js";
import { TuiEventStore } from "./tui-event-store.js";
import type { TuiEntry, TuiEvent, TuiProjection, UiMode } from "./tui-event-store.js";

export { TuiEventStore };

export type {
  TuiEntry,
  TuiEvent,
  TuiEventDraft,
  TuiPhaseProjection,
  TuiProjectedEntry,
  TuiProjection,
  TuiStreamProjection,
  TuiToolCallProjection,
  UiMode,
} from "./tui-event-store.js";

export interface TuiReporterOptions {
  /** 水合或回放时可以传入已有事件库。 */
  eventStore?: TuiEventStore;
  /** 11.4/11.5 可直接消费带稳定 ID 的投影，旧 UI 无需立即改造。 */
  onProjectionUpdate?: (projection: TuiProjection) => void;
}

/**
 * TuiReporter:把 engine 事件翻译成 TuiEntry 数组的增量更新。
 *
 * 每次 engine 回调触发,调用注入的 onUpdate(entries => 新 entries),
 * 让 ink 组件的 setState 驱动重渲染。
 */
export class TuiReporter implements Reporter {
  private currentStream: { entryId: string; streamId: string } | null = null;
  /**
   * 旧 Reporter 调用不携带 toolCallId 时的兼容队列。它只能按同名调用 FIFO
   * 降级，无法判断并发同名工具的乱序完成；新调用应始终传 toolCallId。
   */
  private readonly pendingToolIdsByName = new Map<string, string[]>();
  private readonly eventStore: TuiEventStore;
  private readonly legacyEntries: TuiEntry[];
  private readonly onProjectionUpdate?: (projection: TuiProjection) => void;

  constructor(
    /** 由 App.tsx 注册:收到新 entries 快照后 setState 触发重渲染 */
    private readonly onUpdate: (entries: TuiEntry[]) => void,
    /** 兼容旧用法：投影后同步此数组引用，但它不再是状态源。 */
    entries: TuiEntry[] = [],
    options: TuiReporterOptions = {},
  ) {
    this.eventStore = options.eventStore ?? new TuiEventStore();
    this.legacyEntries = entries;
    this.onProjectionUpdate = options.onProjectionUpdate;

    // 旧调用方可以传入已有 transcript。仅当 store 为空时将它转换为
    // 初始 append 事件；已有事件的 store 始终是权威源。
    if (this.eventStore.size === 0) {
      for (const entry of entries) this.appendEntry(entry);
    }
    this.syncLegacyEntries(this.eventStore.getProjection());
  }

  /** user 消息由 repl 主动 push(不在 Reporter 接口里),暴露此方法供调用 */
  pushUserMessage(content: string): void {
    this.appendEntry({ kind: "user", content });
    this.emit();
  }

  getEntryCount(): number {
    return this.eventStore.getProjection().entries.length;
  }

  /** 完整 append-only 事件快照，供后续持久化、Inspector 与回放接线。 */
  getEvents(): readonly TuiEvent[] {
    return this.eventStore.getEvents();
  }

  /** 带 entry / stream / tool / phase 稳定 ID 的权威投影。 */
  getProjection(): TuiProjection {
    return this.eventStore.getProjection();
  }

  getEventStore(): TuiEventStore {
    return this.eventStore;
  }

  /** 对话 rewind 后让可见 transcript 与 Session 使用同一截断边界。 */
  truncateTo(entryIndex: number): void {
    const entryCount = this.eventStore.getProjection().entries.length;
    const safeIndex = Math.min(Math.max(0, entryIndex), entryCount);
    this.eventStore.append({ type: "transcript.truncated", entryCount: safeIndex });
    this.resetTurnTracking();
    this.appendPhase("idle", true);
    this.emit();
  }

  /** 显式 Skill 激活属于持久 transcript 事件,不伪装成普通用户文本。 */
  pushSkillActivation(input: {
    name: string;
    args: string;
    trigger: "user-slash" | "model-tool";
  }): void {
    this.appendEntry({ kind: "skill", ...input });
    this.emit();
  }

  /** 本地输入命令的系统反馈。 */
  pushSystemMessage(content: string): void {
    this.appendEntry({ kind: "system", content });
    this.emit();
  }

  /** 结构化错误反馈,避免渲染层靠文案前缀猜测。 */
  pushError(message: string, options: { retryable?: boolean; action?: string } = {}): void {
    this.appendEntry({
      kind: "error",
      message,
      ...(options.retryable !== undefined ? { retryable: options.retryable } : {}),
      ...(options.action !== undefined ? { action: options.action } : {}),
    });
    this.emit();
  }

  /** 清空 TUI 当前可见 transcript,不影响底层 session 历史。 */
  clear(): void {
    this.eventStore.append({ type: "transcript.cleared" });
    this.resetTurnTracking();
    this.appendPhase("idle", true);
    this.emit();
  }

  /** 读当前 UI 模式,供 app.tsx 的 spinner 用(repl 每次 onUpdate 后调一次,极简)。 */
  getMode(): UiMode {
    return this.eventStore.getProjection().phase.mode;
  }

  onStart(_workDir: string): void {
    // 顶栏已展示 workDir/model,这里不重复;清空本轮追踪。
    this.resetTurnTracking();
    this.appendPhase("requesting", true);
    this.emit();
  }

  onTurnStart(_turn: number): void {
    // 轮次分隔:结束未收到权威 onMessage 的旧流，确保新轮创建新 streamId。
    this.completeCurrentStreamWithProjectedContent();
    this.currentStream = null;
    this.appendPhase("requesting", true);
    this.emit();
  }

  onThinking(): void {
    this.appendPhase("thinking");
    this.appendEntry({ kind: "thinking" });
    this.emit();
  }

  onToolCall(toolName: string, args: string, toolCallId?: string): void {
    this.appendPhase("tool-use");
    const stableToolCallId = normalizeIdentity(toolCallId) ?? this.eventStore.createId("tool");
    const entryId = this.eventStore.createId("entry");
    this.eventStore.append({
      type: "tool.started",
      entryId,
      toolCallId: stableToolCallId,
      name: toolName,
      args,
    });
    const pending = this.pendingToolIdsByName.get(toolName) ?? [];
    pending.push(stableToolCallId);
    this.pendingToolIdsByName.set(toolName, pending);
    this.emit();
  }

  onToolAwaitingApproval(toolName: string, args: string, toolCallId?: string): void {
    const stableToolCallId = this.resolvePendingToolId(toolName, toolCallId, args);
    if (stableToolCallId !== undefined) {
      this.eventStore.append({
        type: "tool.approval.requested",
        toolCallId: stableToolCallId,
        summary: "等待审批",
      });
    }
    this.appendPhase("tool-use");
    this.emit();
  }

  onToolResult(toolName: string, result: string, isError: boolean, toolCallId?: string): void {
    const stableToolCallId = this.resolvePendingToolId(toolName, toolCallId);
    if (stableToolCallId === undefined) {
      // rewind/clear 后到达的旧结果不再污染当前 transcript。
      this.emit();
      return;
    }
    const tool = this.eventStore.getProjection().toolCalls[stableToolCallId];
    if (!tool) {
      this.removePendingToolId(toolName, stableToolCallId);
      this.emit();
      return;
    }
    this.eventStore.append({
      type: "tool.completed",
      toolCallId: stableToolCallId,
      status: resolveToolStatus(toolName, result, isError),
      summary: summarizeResult(toolName, tool.args, result, isError),
    });
    this.removePendingToolId(toolName, stableToolCallId);
    this.emit();
  }

  onMessage(content: string): void {
    if (this.currentStream) {
      this.eventStore.append({
        type: "assistant.stream.completed",
        ...this.currentStream,
        content,
      });
    } else {
      this.appendEntry({ kind: "assistant", content });
    }
    this.currentStream = null;
    this.emit();
  }

  onFinish(): void {
    this.appendPhase("idle", true);
    this.emit();
  }

  onTextDelta(delta: string): void {
    this.appendPhase("responding");
    if (this.currentStream) {
      this.eventStore.append({
        type: "assistant.stream.delta",
        ...this.currentStream,
        delta,
      });
    } else {
      this.currentStream = {
        entryId: this.eventStore.createId("entry"),
        streamId: this.eventStore.createId("stream"),
      };
      this.eventStore.append({
        type: "assistant.stream.started",
        ...this.currentStream,
        delta,
      });
    }
    this.emit();
  }

  private appendEntry(entry: TuiEntry): string {
    const entryId = this.eventStore.createId("entry");
    this.eventStore.append({ type: "entry.appended", entryId, entry });
    return entryId;
  }

  private appendPhase(mode: UiMode, force = false): void {
    if (!force && this.eventStore.getProjection().phase.mode === mode) return;
    this.eventStore.append({
      type: "phase.changed",
      phaseId: this.eventStore.createId("phase"),
      mode,
    });
  }

  private completeCurrentStreamWithProjectedContent(): void {
    if (!this.currentStream) return;
    const currentStream = this.currentStream;
    const projected = this.eventStore
      .getProjection()
      .entries.find((entry) => entry.id === currentStream.entryId);
    if (!projected || projected.entry.kind !== "assistant") return;
    this.eventStore.append({
      type: "assistant.stream.completed",
      ...currentStream,
      content: projected.entry.content,
    });
  }

  private resetTurnTracking(): void {
    this.currentStream = null;
    this.pendingToolIdsByName.clear();
  }

  private resolvePendingToolId(
    toolName: string,
    toolCallId?: string,
    expectedArgs?: string,
  ): string | undefined {
    const explicitId = normalizeIdentity(toolCallId);
    const projection = this.eventStore.getProjection();
    if (explicitId !== undefined) {
      const tool = projection.toolCalls[explicitId];
      return tool && tool.name === toolName && isPendingToolStatus(tool.status)
        ? explicitId
        : undefined;
    }

    // 兼容旧调用：审批优先选最早的同参数调用，结果选最早的同名调用。
    // 不再从 entries 尾部倒序猜测。
    const pendingIds = this.pendingToolIdsByName.get(toolName) ?? [];
    return pendingIds.find((id) => {
      const tool = projection.toolCalls[id];
      return (
        tool !== undefined &&
        isPendingToolStatus(tool.status) &&
        (expectedArgs === undefined || tool.args === expectedArgs)
      );
    });
  }

  private removePendingToolId(toolName: string, toolCallId: string): void {
    const pending = this.pendingToolIdsByName.get(toolName);
    if (!pending) return;
    const next = pending.filter((id) => id !== toolCallId);
    if (next.length === 0) this.pendingToolIdsByName.delete(toolName);
    else this.pendingToolIdsByName.set(toolName, next);
  }

  /** 投影是唯一条目源；legacyEntries 仅作引用兼容镜像。 */
  private emit(): void {
    const projection = this.eventStore.getProjection();
    this.syncLegacyEntries(projection);
    this.onProjectionUpdate?.(projection);
    this.onUpdate(projection.entries.map(({ entry }) => entry));
  }

  private syncLegacyEntries(projection: TuiProjection): void {
    this.legacyEntries.splice(
      0,
      this.legacyEntries.length,
      ...projection.entries.map(({ entry }) => entry),
    );
  }
}

function normalizeIdentity(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

/** 工具结果摘要:默认短输出;写入类和 bash 保留路径/命令上下文,错误保留可复制摘要。 */
function summarizeResult(toolName: string, args: string, result: string, isError: boolean): string {
  if (isError) return formatErrorSummary(result);

  if (isAgentToolName(toolName)) {
    return summarizeAgentResult(toolName, result);
  }

  const target = toolTargetSummary(toolName, args);
  const output = formatOutputPreview(result, { maxLines: 3 });
  if (target) return `${target} · ${result.length} 字节 · ${output}`;

  const lines = result.split("\n");
  const head = lines.slice(0, 3).map((l) => l.slice(0, 100));
  const suffix = lines.length > 3 ? ` …(+${lines.length - 3} 行)` : "";
  return `${result.length} 字节 · ${head.join(" ⏎ ").slice(0, 120)}${suffix}`;
}

function resolveToolStatus(toolName: string, result: string, isError: boolean): ToolCardStatus {
  if (!isError)
    return isAgentToolName(toolName) && agentResultHasFailure(result) ? "error" : "success";
  return isDeniedResult(result) ? "denied" : "error";
}

function isPendingToolStatus(status: ToolCardStatus): boolean {
  return status === "queued" || status === "running" || status === "approval";
}

function isAgentToolName(toolName: string): boolean {
  return (
    toolName === "spawn_subagent" ||
    toolName === "delegate_task" ||
    toolName === "delegate_status" ||
    toolName.startsWith("[Subagent]")
  );
}

function isDeniedResult(result: string): boolean {
  return (
    result.includes("执行被系统拦截") ||
    result.includes("执行被 Guardrail 阻断") ||
    result.includes("被 PreToolUse hook 阻断") ||
    result.includes("permissionDecision: deny")
  );
}

function toolTargetSummary(toolName: string, args: string): string | undefined {
  if (!["edit_file", "write_file", "bash"].includes(toolName)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const value = toolName === "bash" ? obj["command"] : obj["path"];
  if (typeof value !== "string" || !value.trim()) return undefined;
  return compactText(value.trim(), 64);
}

function formatErrorSummary(error: string): string {
  const firstUsefulLine = error
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return `可复制错误: ${compactText(firstUsefulLine ?? error, 166)}`;
}

function compactText(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function summarizeAgentResult(toolName: string, result: string): string {
  const parsed = parseJsonObject(result);
  if (!parsed) return summarizePlainAgentResult(toolName, result);

  const topLevelError = stringField(parsed, "error");
  if (topLevelError) return formatErrorSummary(topLevelError);

  const status = stringField(parsed, "status");
  const delegationId = stringField(parsed, "delegationId") ?? stringField(parsed, "delegation_id");
  const batch = extractDelegationBatch(parsed);
  if (batch) return summarizeDelegationBatch(batch);

  if (status) {
    const idPart = delegationId ? ` · ${compactText(delegationId, 48)}` : "";
    return `${status}${idPart}`;
  }

  return summarizePlainAgentResult(toolName, result);
}

function summarizePlainAgentResult(toolName: string, result: string): string {
  const label = toolName.startsWith("[Subagent]") ? "Subagent" : "Agent";
  return `${label} · ${formatOutputPreview(result, { maxLines: 3 })}`;
}

function agentResultHasFailure(result: string): boolean {
  const parsed = parseJsonObject(result);
  if (!parsed) return result.startsWith("子智能体执行失败:");
  if (stringField(parsed, "error")) return true;

  const batch = extractDelegationBatch(parsed);
  return batch ? batch.results.some((item) => stringField(item, "status") === "error") : false;
}

function extractDelegationBatch(
  value: Record<string, unknown>,
): { results: Record<string, unknown>[] } | undefined {
  const direct = value["results"];
  if (Array.isArray(direct)) return { results: direct.filter(isRecord) };

  const nestedResult = value["result"];
  if (isRecord(nestedResult)) {
    const nested = nestedResult["results"];
    if (Array.isArray(nested)) return { results: nested.filter(isRecord) };
  }

  return undefined;
}

function summarizeDelegationBatch(batch: { results: Record<string, unknown>[] }): string {
  const total = batch.results.length;
  const completed = batch.results.filter(
    (item) => stringField(item, "status") === "completed",
  ).length;
  const failed = batch.results.filter((item) => stringField(item, "status") === "error").length;

  const parts = [`${completed}/${total} completed`];
  if (failed > 0) parts.push(`${failed} failed`);

  const success = batch.results.find((item) => stringField(item, "status") === "completed");
  const failure = batch.results.find((item) => stringField(item, "status") === "error");
  const successSummary = success ? stringField(success, "summary") : undefined;
  const failureSummary = failure
    ? (stringField(failure, "error") ?? stringField(failure, "summary"))
    : undefined;

  if (successSummary) parts.push(`ok: ${compactText(successSummary, 72)}`);
  if (failureSummary) parts.push(`failed: ${compactText(failureSummary, 88)}`);

  return compactText(parts.join(" · "), 220);
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

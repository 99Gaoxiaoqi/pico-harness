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
import type {
  TuiEntry,
  TuiEvent,
  TuiProjection,
  TuiToolCallProjection,
  UiMode,
} from "./tui-event-store.js";
import { joinToolOutput } from "./tui-event-store.js";

/** Bash 的外部化阈值是 30k；多留少量余量后立即停止向 append-only 日志写正文。 */
export const TUI_TOOL_OUTPUT_MEMORY_LIMIT_CHARS = 32_000;
export const TUI_INLINE_TOOL_RESULT_LIMIT_CHARS = 50_000;

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
   * EventStore 内部 tool ID 的待完成索引。Provider call ID 仅作
   * 当前 pending 队列的关联键，不作为事件全局 ID，因为 Gemini 会跨轮复用它。
   */
  private readonly pendingToolIdsByName = new Map<string, string[]>();
  private readonly pendingToolIdsByProviderCallId = new Map<string, string[]>();
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
    this.rebuildRuntimeTracking();
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
    this.interruptActiveStreams("truncate");
    this.eventStore.append({ type: "transcript.truncated", entryCount: safeIndex });
    this.clearRuntimeTracking();
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
    this.interruptActiveStreams("clear");
    this.eventStore.append({ type: "transcript.cleared" });
    this.clearRuntimeTracking();
    this.appendPhase("idle", true);
    this.emit();
  }

  /** 读当前 UI 模式,供 app.tsx 的 spinner 用(repl 每次 onUpdate 后调一次,极简)。 */
  getMode(): UiMode {
    return this.eventStore.getProjection().phase.mode;
  }

  onStart(_workDir: string): void {
    // 新请求不继承上一次异常退出的 streaming/pending 运行态。
    this.interruptActiveStreams("new-request");
    this.clearRuntimeTracking();
    this.appendPhase("requesting", true);
    this.emit();
  }

  onTurnStart(_turn: number): void {
    // 轮次分隔:结束未收到权威 onMessage 的旧流，确保新轮创建新 streamId。
    this.completeActiveStreams();
    this.appendPhase("requesting", true);
    this.emit();
  }

  onThinking(): void {
    this.appendPhase("thinking");
    this.appendEntry({ kind: "thinking" });
    this.emit();
  }

  onToolCall(toolName: string, args: string, providerCallId?: string): void {
    this.appendPhase("tool-use");
    const normalizedProviderCallId = normalizeIdentity(providerCallId);
    const entryId = this.eventStore.createId("entry");
    const event = this.eventStore.append({
      type: "tool.started",
      entryId,
      ...(normalizedProviderCallId !== undefined
        ? { providerCallId: normalizedProviderCallId }
        : {}),
      name: toolName,
      args,
    });
    if (event.type !== "tool.started") {
      throw new Error("TUI EventStore returned an unexpected event for tool.started");
    }
    const internalToolCallId = event.toolCallId;
    const tool = this.eventStore.getProjection().toolCalls[internalToolCallId];
    if (tool) this.registerPendingTool(tool);
    this.emit();
  }

  onToolAwaitingApproval(toolName: string, args: string, providerCallId?: string): void {
    const internalToolCallId = this.resolvePendingToolId(toolName, providerCallId, args);
    if (internalToolCallId !== undefined) {
      this.eventStore.append({
        type: "tool.approval.requested",
        toolCallId: internalToolCallId,
        summary: "等待审批",
      });
    }
    this.appendPhase("tool-use");
    this.emit();
  }

  onToolOutput(
    toolName: string,
    stream: "stdout" | "stderr",
    chunk: string,
    providerCallId?: string,
  ): void {
    if (chunk.length === 0) return;
    const internalToolCallId = this.resolvePendingToolId(toolName, providerCallId);
    if (internalToolCallId === undefined) return;
    const tool = this.eventStore.getProjection().toolCalls[internalToolCallId];
    if (!tool || tool.outputTruncated) return;

    // 上限在 append 前生效：event log 与 projection 都不会持有上限外正文。
    const remaining = Math.max(0, TUI_TOOL_OUTPUT_MEMORY_LIMIT_CHARS - tool.outputChars);
    const retained = remaining > 0 ? chunk.slice(0, remaining) : "";
    if (retained.length > 0) {
      this.eventStore.append({
        type: "tool.output",
        toolCallId: internalToolCallId,
        stream,
        chunk: retained,
      });
    }
    const droppedChars = chunk.length - retained.length;
    if (droppedChars > 0) {
      this.eventStore.append({
        type: "tool.output.truncated",
        toolCallId: internalToolCallId,
        droppedChars,
      });
    }
    this.emit();
  }

  onToolResult(toolName: string, result: string, isError: boolean, providerCallId?: string): void {
    const internalToolCallId = this.resolvePendingToolId(toolName, providerCallId);
    if (internalToolCallId === undefined) {
      // rewind/clear 后到达的旧结果不再污染当前 transcript。
      this.emit();
      return;
    }
    const tool = this.eventStore.getProjection().toolCalls[internalToolCallId];
    if (!tool) {
      this.removePendingToolId(toolName, internalToolCallId, normalizeIdentity(providerCallId));
      this.emit();
      return;
    }
    const externalized = parseExternalizedToolResult(result);
    const streamedResult = joinToolOutput(tool.output);
    const oversizedWithoutArtifact =
      externalized === undefined && result.length > TUI_INLINE_TOOL_RESULT_LIMIT_CHARS;
    const truncated = externalized !== undefined || oversizedWithoutArtifact;
    const canReuseStreamedResult =
      !truncated && !tool.outputTruncated && streamedResult.length > 0 && streamedResult === result;
    const summary = externalized
      ? formatExternalizedResultSummary(externalized)
      : summarizeResult(toolName, tool.args, result, isError);
    this.eventStore.append({
      type: "tool.completed",
      toolCallId: internalToolCallId,
      status: resolveToolStatus(toolName, result, isError),
      summary,
      ...(!truncated && !canReuseStreamedResult ? { inlineResult: result } : {}),
      ...(externalized?.artifactRef !== undefined ? { artifactRef: externalized.artifactRef } : {}),
      ...(externalized?.artifactPath !== undefined
        ? { artifactPath: externalized.artifactPath }
        : {}),
      size: externalized?.originalChars ?? result.length,
      truncated,
    });
    this.removePendingTool(tool);
    this.emit();
  }

  onMessage(content: string): void {
    if (this.currentStream) {
      const projectedContent = this.projectedStreamContent(this.currentStream);
      this.eventStore.append({
        type: "assistant.stream.completed",
        ...this.currentStream,
        ...(projectedContent !== content ? { content } : {}),
      });
    } else {
      this.appendEntry({ kind: "assistant", content });
    }
    this.currentStream = null;
    this.emit();
  }

  onFinish(): void {
    this.completeActiveStreams();
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

  private completeActiveStreams(): void {
    for (const stream of this.activeStreams()) {
      this.eventStore.append({ type: "assistant.stream.completed", ...stream });
    }
    this.currentStream = null;
  }

  private interruptActiveStreams(reason: "new-request" | "clear" | "truncate"): void {
    for (const stream of this.activeStreams()) {
      this.eventStore.append({ type: "assistant.stream.interrupted", ...stream, reason });
    }
    this.currentStream = null;
  }

  private clearRuntimeTracking(): void {
    this.currentStream = null;
    this.pendingToolIdsByName.clear();
    this.pendingToolIdsByProviderCallId.clear();
  }

  /** 从水合投影重建 reporter 的短命运行态，不依赖旧实例内存。 */
  private rebuildRuntimeTracking(): void {
    this.clearRuntimeTracking();
    const projection = this.eventStore.getProjection();
    for (const projected of projection.entries) {
      if (projected.streamId !== undefined) {
        const stream = projection.streams[projected.streamId];
        if (stream?.status === "streaming") {
          this.currentStream = { entryId: stream.entryId, streamId: stream.id };
        }
      }
      if (projected.toolCallId !== undefined) {
        const tool = projection.toolCalls[projected.toolCallId];
        if (tool && isPendingToolStatus(tool.status)) this.registerPendingTool(tool);
      }
    }
  }

  private activeStreams(): Array<{ entryId: string; streamId: string }> {
    const projection = this.eventStore.getProjection();
    return projection.entries.flatMap((entry) => {
      if (entry.streamId === undefined) return [];
      const stream = projection.streams[entry.streamId];
      return stream?.status === "streaming"
        ? [{ entryId: stream.entryId, streamId: stream.id }]
        : [];
    });
  }

  private projectedStreamContent(stream: { entryId: string }): string | undefined {
    const projected = this.eventStore
      .getProjection()
      .entries.find((entry) => entry.id === stream.entryId);
    return projected?.entry.kind === "assistant" ? projected.entry.content : undefined;
  }

  private registerPendingTool(tool: TuiToolCallProjection): void {
    appendPendingId(this.pendingToolIdsByName, tool.name, tool.id);
    if (tool.providerCallId !== undefined) {
      appendPendingId(this.pendingToolIdsByProviderCallId, tool.providerCallId, tool.id);
    }
  }

  private resolvePendingToolId(
    toolName: string,
    providerCallId?: string,
    expectedArgs?: string,
  ): string | undefined {
    const normalizedProviderCallId = normalizeIdentity(providerCallId);
    const projection = this.eventStore.getProjection();
    const pendingIds =
      normalizedProviderCallId !== undefined
        ? (this.pendingToolIdsByProviderCallId.get(normalizedProviderCallId) ?? [])
        : (this.pendingToolIdsByName.get(toolName) ?? []);

    // Provider ID 跨轮可复用，因此只在当前 pending 队列中 FIFO 解析；
    // 无 ID 的旧调用则按同名工具 FIFO 降级。
    return pendingIds.find((id) => {
      const tool = projection.toolCalls[id];
      return (
        tool !== undefined &&
        isPendingToolStatus(tool.status) &&
        (expectedArgs === undefined || tool.args === expectedArgs)
      );
    });
  }

  private removePendingTool(tool: TuiToolCallProjection): void {
    this.removePendingToolId(tool.name, tool.id, tool.providerCallId);
  }

  private removePendingToolId(
    toolName: string,
    internalToolCallId: string,
    providerCallId?: string,
  ): void {
    removePendingId(this.pendingToolIdsByName, toolName, internalToolCallId);
    if (providerCallId !== undefined) {
      removePendingId(this.pendingToolIdsByProviderCallId, providerCallId, internalToolCallId);
    }
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

export interface ExternalizedToolResultMetadata {
  artifactRef?: string;
  artifactPath?: string;
  artifactId?: string;
  originalChars?: number;
  summary: string;
}

/** 只识别 observation processor 的结构化占位格式，不从普通工具文本猜路径。 */
export function parseExternalizedToolResult(
  result: string,
): ExternalizedToolResultMetadata | undefined {
  if (!result.startsWith("[大型工具输出已外部化]\n")) return undefined;
  const lines = result.split("\n");
  const summaryIndex = lines.indexOf("summary:");
  const metadataLines = lines.slice(1, summaryIndex === -1 ? lines.length : summaryIndex);
  const metadata = new Map<string, string>();
  for (const line of metadataLines) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (value.length > 0) metadata.set(key, value);
  }
  const parsedSize = Number(metadata.get("originalChars"));
  return {
    ...(metadata.has("artifactUri") ? { artifactRef: metadata.get("artifactUri")! } : {}),
    ...(metadata.has("artifactPath") ? { artifactPath: metadata.get("artifactPath")! } : {}),
    ...(metadata.has("artifactId") ? { artifactId: metadata.get("artifactId")! } : {}),
    ...(Number.isSafeInteger(parsedSize) && parsedSize >= 0 ? { originalChars: parsedSize } : {}),
    summary:
      summaryIndex === -1
        ? "大型工具输出已保存到 artifact。"
        : lines.slice(summaryIndex + 1).join("\n"),
  };
}

function formatExternalizedResultSummary(metadata: ExternalizedToolResultMetadata): string {
  const summary = metadata.summary.trim() || "大型工具输出已保存到 artifact。";
  const location = metadata.artifactRef ?? metadata.artifactId;
  return location ? `${summary}\n\n完整结果: ${location}` : summary;
}

function normalizeIdentity(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function appendPendingId(index: Map<string, string[]>, key: string, id: string): void {
  const pending = index.get(key) ?? [];
  pending.push(id);
  index.set(key, pending);
}

function removePendingId(index: Map<string, string[]>, key: string, id: string): void {
  const pending = index.get(key);
  if (!pending) return;
  const next = pending.filter((candidate) => candidate !== id);
  if (next.length === 0) index.delete(key);
  else index.set(key, next);
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

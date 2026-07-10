// TUI Reporter:把 Agent 引擎的事件流转成 React 可渲染的状态(对标 Claude Code ink 架构)。
//
// 设计:Reporter 接口是 engine 与 I/O 的解耦点(reporter.ts)。
// 本类把 8 个回��(onStart/onTurnStart/onThinking/onToolCall/onToolResult/onMessage/onFinish/onTextDelta)
// 转成对 onUpdate 回调的调用,后者由 ink 的 <App> 组件注册为 setState。
//
// 状态机:TUI 维护一个 entries 数组(对话流),reporter 往里追加条目:
//   - user 消息(由 repl 主动 push,非 reporter 回调)
//   - assistant 流式输出(onTextDelta 累积)
//   - 工具调用卡片(onToolCall → onToolResult 配对)
//   - 思考中 spinner(onThinking)
//
// 不直接渲染 ink 组件(保持 reporter 纯数据层),渲染由 App.tsx 消费 state ��成。

import type { Reporter } from "../engine/reporter.js";
import type { SpinnerMode } from "./spinner.js";
import { formatOutputPreview } from "./diff-preview.js";
import type { ToolCardStatus } from "./tool-card.js";

/**
 * UI 模式:SpinnerMode 扩展一个 "idle"(空闲,无 spinner)。
 * app.tsx / repl.tsx 据此决定 spinner 是否显示、显示哪个阶段。
 */
export type UiMode = SpinnerMode | "idle";

/** 对话流中的一条记录。简化为联合类型,App.tsx 按 kind 分发渲染。 */
export type TuiEntry =
  | { kind: "user"; content: string }
  | { kind: "system"; content: string }
  | { kind: "assistant"; content: string }
  | { kind: "tool"; name: string; args: string; status: ToolCardStatus; summary?: string }
  | { kind: "thinking" };

/**
 * TuiReporter:把 engine 事件翻译成 TuiEntry 数组的增量更新。
 *
 * 每次 engine 回调触发,调用注入的 onUpdate(entries => 新 entries),
 * 让 ink 组件的 setState 驱动重渲染。
 */
export class TuiReporter implements Reporter {
  /** 当前轮正在流式累积的 assistant 文本(临时缓冲,onMessage 时固化) */
  private streamingText = "";
  /** 当前轮流式 assistant 在 entries 中的索引(onTextDelta 首次创建时记下,避免多轮串) */
  private streamingEntryIdx: number | null = null;
  /** 当前轮正在运行的工具名栈(支持嵌套,但实际并发批次会被串行回调) */
  private pendingTools = new Set<string>();
  /** 当前 UI 模式(SpinnerMode | "idle"),供 spinner 切换阶段。 */
  private spinnerMode: UiMode = "idle";

  constructor(
    /** 由 App.tsx 注册:收到新 entries 快照后 setState 触发重渲染 */
    private readonly onUpdate: (entries: TuiEntry[]) => void,
    /** 当前 entries 的可变引用(reporter 直接 mutate 后传快照给 onUpdate) */
    private readonly entries: TuiEntry[] = [],
  ) {}

  /** user 消息由 repl 主动 push(不在 Reporter 接口里),暴露此方法供调用 */
  pushUserMessage(content: string): void {
    this.entries.push({ kind: "user", content });
    this.emit();
  }

  /** 本地输入命令的系统反馈。 */
  pushSystemMessage(content: string): void {
    this.entries.push({ kind: "system", content });
    this.emit();
  }

  /** 清空 TUI 当前可见 transcript,不影响底层 session 历史。 */
  clear(): void {
    this.entries.splice(0, this.entries.length);
    this.resetTurnBuffer();
    this.pendingTools.clear();
    this.spinnerMode = "idle";
    this.emit();
  }

  /** 读当前 UI 模式,供 app.tsx 的 spinner 用(repl 每次 onUpdate 后调一次,极简)。 */
  getMode(): UiMode {
    return this.spinnerMode;
  }

  onStart(_workDir: string): void {
    // 顶栏已展示 workDir/model,这里不重复;清空本轮缓冲。
    this.resetTurnBuffer();
    this.pendingTools.clear();
    this.spinnerMode = "requesting"; // 等首包
    this.emit();
  }

  onTurnStart(_turn: number): void {
    // 轮次分隔:重置流式缓冲,确保每轮的 onTextDelta 创建新 assistant 条目,
    // 不追加到上一轮已固化的条目上(根治多轮重复/混乱)。
    this.resetTurnBuffer();
    this.spinnerMode = "requesting"; // 新一轮,等首包
  }

  onThinking(): void {
    // Provider 原生 thinking 流可复用该占位,spinner 据此显示。
    this.spinnerMode = "thinking";
    this.entries.push({ kind: "thinking" });
    this.emit();
  }

  onToolCall(toolName: string, args: string): void {
    this.spinnerMode = "tool-use"; // 工具执行中
    this.pendingTools.add(toolName);
    this.entries.push({ kind: "tool", name: toolName, args, status: "running" });
    this.emit();
  }

  onToolAwaitingApproval(toolName: string, args: string): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.kind === "tool" && e.name === toolName && e.args === args && isPendingToolStatus(e.status)) {
        this.entries[i] = { ...e, status: "approval", summary: "等待审批" };
        break;
      }
    }
    this.spinnerMode = "tool-use";
    this.emit();
  }

  onToolResult(toolName: string, result: string, isError: boolean): void {
    // 找到最后一个同名的 pending 工具卡片,更新它的状态
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.kind === "tool" && e.name === toolName && isPendingToolStatus(e.status)) {
        this.entries[i] = {
          ...e,
          status: resolveToolStatus(toolName, result, isError),
          summary: summarizeResult(toolName, e.args, result, isError),
        };
        break;
      }
    }
    this.pendingTools.delete(toolName);
    this.emit();
  }

  onMessage(content: string): void {
    // 模型完成一轮纯文本回复:用权威完整版替换本轮流式缓冲创建的条目。
    // 若本轮无流式 delta(streamingEntryIdx===null,如非流式 provider),直接 push。
    if (this.streamingEntryIdx !== null && this.streamingEntryIdx < this.entries.length) {
      const entry = this.entries[this.streamingEntryIdx];
      if (entry && entry.kind === "assistant") {
        entry.content = content; // 流式版本→权威版本
      }
    } else {
      this.entries.push({ kind: "assistant", content });
    }
    this.resetTurnBuffer(); // 固化后清缓冲,下一轮 onTextDelta 会创建新条目
    this.emit();
  }

  onFinish(): void {
    // 任务完成:App 据此切回 idle 状态(显示输入框)。无需额外条目。
    this.spinnerMode = "idle"; // 回到空闲
    this.emit();
  }

  onTextDelta(delta: string): void {
    // 流式增量:累积到本轮专属的 assistant 条目(由 streamingEntryIdx 精确定位)。
    // 首次 delta 时创建条目并记下索引;后续 delta 追加到同一条目。
    // 不再用"entries 末尾"定位——多轮(调工具→继续回复)时末尾可能是工具卡片。
    this.spinnerMode = "responding"; // 生成回复中
    this.streamingText += delta;
    if (this.streamingEntryIdx !== null && this.streamingEntryIdx < this.entries.length) {
      const entry = this.entries[this.streamingEntryIdx];
      if (entry && entry.kind === "assistant") {
        entry.content += delta;
      }
    } else {
      this.entries.push({ kind: "assistant", content: delta });
      this.streamingEntryIdx = this.entries.length - 1;
    }
    this.emit();
  }

  /** 重置本轮流式缓冲:onMessage 固化后 / onTurnStart 新轮开始时调 */
  private resetTurnBuffer(): void {
    this.streamingText = "";
    this.streamingEntryIdx = null;
  }

  /** 把当前 entries 的快照推给 onUpdate,驱动 ink 重渲染 */
  private emit(): void {
    // 浅拷贝数组(元素是引用,ink 靠 .length 变化触发渲染)
    this.onUpdate([...this.entries]);
  }
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
  if (!isError) return isAgentToolName(toolName) && agentResultHasFailure(result) ? "error" : "success";
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

function extractDelegationBatch(value: Record<string, unknown>): { results: Record<string, unknown>[] } | undefined {
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
  const completed = batch.results.filter((item) => stringField(item, "status") === "completed").length;
  const failed = batch.results.filter((item) => stringField(item, "status") === "error").length;

  const parts = [`${completed}/${total} completed`];
  if (failed > 0) parts.push(`${failed} failed`);

  const success = batch.results.find((item) => stringField(item, "status") === "completed");
  const failure = batch.results.find((item) => stringField(item, "status") === "error");
  const successSummary = success ? stringField(success, "summary") : undefined;
  const failureSummary = failure ? stringField(failure, "error") ?? stringField(failure, "summary") : undefined;

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

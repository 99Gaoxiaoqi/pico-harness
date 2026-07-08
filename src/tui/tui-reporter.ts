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

/**
 * UI 模式:SpinnerMode 扩展一个 "idle"(空闲,无 spinner)。
 * app.tsx / repl.tsx 据此决定 spinner 是否显示、显示哪个阶段。
 */
export type UiMode = SpinnerMode | "idle";

/** 对话流中的一条记录。简化为联合类型,App.tsx 按 kind 分发渲染。 */
export type TuiEntry =
  | { kind: "user"; content: string }
  | { kind: "assistant"; content: string }
  | { kind: "tool"; name: string; args: string; status: "running" | "done" | "error"; summary?: string }
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

  /** 本地输入命令的系统反馈。渲染层尚无 system kind,先复用 assistant 气泡承载。 */
  pushSystemMessage(content: string): void {
    this.entries.push({ kind: "assistant", content });
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

  onStart(_workDir: string, _enableThinking: boolean): void {
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
    // 进入慢思考:push 一个 thinking 占位,spinner 据此显示
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

  onToolResult(toolName: string, result: string, isError: boolean): void {
    // 找到最后一个同名的 running 工具卡片,更新它的状态
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.kind === "tool" && e.name === toolName && e.status === "running") {
        e.status = isError ? "error" : "done";
        e.summary = summarizeResult(result);
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

/** 工具结果摘要:前 3 行,每行截断 100 字符(对齐 TerminalReporter 的摘要逻辑) */
function summarizeResult(result: string): string {
  const lines = result.split("\n");
  const head = lines.slice(0, 3).map((l) => l.slice(0, 100));
  const suffix = lines.length > 3 ? ` …(+${lines.length - 3} 行)` : "";
  return `${result.length} 字节 · ${head.join(" ⏎ ").slice(0, 120)}${suffix}`;
}

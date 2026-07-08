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
  /** 当前轮正在运行的工具名栈(支持嵌套,但实际并发批次会被串行回调) */
  private pendingTools = new Set<string>();

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

  onStart(_workDir: string, _enableThinking: boolean): void {
    // 顶栏已展示 workDir/model,这里不重复;清空本轮缓冲。
    this.streamingText = "";
    this.pendingTools.clear();
    this.emit();
  }

  onTurnStart(_turn: number): void {
    // 轮次分隔由 App 渲染处理,这里重置本轮缓冲
    this.streamingText = "";
  }

  onThinking(): void {
    // 进入慢思考:push 一个 thinking 占位,spinner 据此显示
    this.entries.push({ kind: "thinking" });
    this.emit();
  }

  onToolCall(toolName: string, args: string): void {
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
    // 模型完成一轮纯文本回复:把流式缓冲固化为一条 assistant 条目
    // (若本轮有流式 delta,streamingText 已含内容;onMessage 是权威完整版)
    if (this.streamingText) {
      // 替换最后一条流式 assistant 为权威版本
      const last = this.entries[this.entries.length - 1];
      if (last && last.kind === "assistant") {
        last.content = content;
      } else {
        this.entries.push({ kind: "assistant", content });
      }
    } else {
      this.entries.push({ kind: "assistant", content });
    }
    this.streamingText = "";
    this.emit();
  }

  onFinish(): void {
    // 任务完成:App 据此切回 idle 状态(显示输入框)。无需额外条目。
    this.emit();
  }

  onTextDelta(delta: string): void {
    // 流式增量:累积到缓冲,追加/更新最后一条 assistant 条目
    this.streamingText += delta;
    const last = this.entries[this.entries.length - 1];
    if (last && last.kind === "assistant") {
      last.content += delta;
    } else {
      this.entries.push({ kind: "assistant", content: delta });
    }
    this.emit();
  }

  /** 把当前 entries 的快照推给 onUpdate,驱动 ink 重渲染 */
  private emit(): void {
    // 浅拷贝数���(元素是引用,ink 靠 .length 变化触发渲染)
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

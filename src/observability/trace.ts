// 链路追踪(Tracing):为 Agent 引入决策树回放机制,透视大模型黑盒。
//
// 解决痛点:Agent 跑5分钟15个Turn后"无法修复",面对满屏日志无法定位哪步跑偏。
// 大模型是不可控黑盒,不提供"X光机",智障行为将无法调试。
//
// 借鉴云原生 OpenTelemetry/Jaeger,追踪对象从网络节点变成智能体决策层级:
// - Root Span:一次完整 Run 任务
// - Child Spans:ReAct 循环的每个 Turn
// - Leaf Spans:Turn 内细分操作(Generate/Execute/Compaction)
//
// Node 无 Go 的 context.Context,主路径用显式父 Span 管理:startChild 直接把子节点
// 挂到当前 Turn 下。Tracer 仍保留 startSpan/endSpan,供简单的串行调用场景使用。
// 最终导出 JSON 决策树到 .claw/traces/,像读病历一样逐帧复盘。

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type TraceAttributes = Record<string, unknown>;

/** Span:链路追踪中的一个时间跨度和操作节点 */
export class Span {
  readonly name: string;
  readonly startTime: number;
  endTime?: number;
  durationMs?: number;
  readonly attributes: Record<string, unknown> = {};
  readonly children: Span[] = [];
  /** 父节点(根 Span 为 null) */
  readonly parent: Span | null;
  private readonly now: () => number;

  constructor(
    name: string,
    parent: Span | null,
    now: () => number = Date.now,
    attributes: TraceAttributes = {},
  ) {
    this.name = name;
    this.parent = parent;
    this.now = now;
    this.startTime = this.now();
    this.addAttributes(attributes);
  }

  /** 开启一个显式子 Span。TS 没有 Go context,用父节点直接挂载避免并发错位。 */
  startChild(name: string, attributes: TraceAttributes = {}): Span {
    const span = new Span(name, this, this.now, attributes);
    this.children.push(span);
    return span;
  }

  /** 结束跨度,计算耗时 */
  end(): void {
    if (this.endTime !== undefined) {
      return;
    }
    this.endTime = this.now();
    this.durationMs = this.endTime - this.startTime;
  }

  /** 记录关键元数据 */
  addAttribute(key: string, value: unknown): void {
    if (value === undefined) {
      return;
    }
    this.attributes[key] = value;
  }

  /** 批量记录关键元数据 */
  addAttributes(attributes: TraceAttributes): void {
    for (const [key, value] of Object.entries(attributes)) {
      this.addAttribute(key, value);
    }
  }

  /** 序列化为纯 JSON 友好对象(去掉 parent 避免循环引用) */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      startTime: new Date(this.startTime).toISOString(),
      endTime: this.endTime ? new Date(this.endTime).toISOString() : undefined,
      durationMs: this.durationMs,
      attributes: this.attributes,
      children: this.children.map((c) => c.toJSON()),
    };
  }
}

/**
 * Tracer:链路追踪器,栈式管理当前 Span。
 * StartSpan 挂为当前 Span 的 child 并切换;EndSpan 回退到 parent。
 */
export interface TracerOptions {
  now?: () => number;
}

export class Tracer {
  private rootSpan: Span | null = null;
  private currentSpan: Span | null = null;

  constructor(private readonly options: TracerOptions = {}) {}

  /** 开启根 Span(整个任务的根节点) */
  startRoot(name: string, attributes: TraceAttributes = {}): Span {
    this.rootSpan = new Span(name, null, this.options.now ?? Date.now, attributes);
    this.currentSpan = this.rootSpan;
    return this.rootSpan;
  }

  /** 开启子 Span,自动挂到当前 Span 下并切换为当前 */
  startSpan(name: string, attributes: TraceAttributes = {}): Span {
    if (!this.currentSpan) {
      // 无当前 Span 时退化为根
      return this.startRoot(name, attributes);
    }
    const span = this.currentSpan.startChild(name, attributes);
    this.currentSpan = span;
    return span;
  }

  /** 结束当前 Span,回退到父节点 */
  endSpan(span: Span): void {
    span.end();
    if (this.currentSpan === span) {
      this.currentSpan = span.parent;
    }
  }

  /** 获取根 Span(供导出) */
  getRoot(): Span | null {
    return this.rootSpan;
  }

  /** 序列化当前根 Span */
  snapshot(): Record<string, unknown> {
    if (!this.rootSpan) {
      throw new Error("Tracer has no root span.");
    }
    return this.rootSpan.toJSON();
  }

  /** 导出当前根 Span 到文件 */
  exportToFile(workDir: string, sessionId: string): string {
    if (!this.rootSpan) {
      throw new Error("Tracer has no root span.");
    }
    return exportTraceToFile(this.rootSpan, workDir, sessionId, this.options.now?.());
  }

  /** 重置(测试用) */
  reset(): void {
    this.rootSpan = null;
    this.currentSpan = null;
  }
}

/**
 * 将根 Span 序列化并保存为本地 JSON 文件。
 * 像读病历一样逐帧复盘 Agent 的全量决策路径。
 */
export function exportTraceToFile(
  rootSpan: Span,
  workDir: string,
  sessionId: string,
  timestamp: number = Date.now(),
): string {
  const traceDir = join(workDir, ".claw", "traces");
  mkdirSync(traceDir, { recursive: true });
  const filename = `trace_${sanitizeFilePart(sessionId)}_${timestamp}.json`;
  const filepath = join(traceDir, filename);
  const data = JSON.stringify(rootSpan.toJSON(), null, 2);
  writeFileSync(filepath, data, "utf8");
  return filepath;
}

/** 截断字符串(防 Trace 文件过度膨胀) */
export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

/** 清洗文件名片段,防止 sessionId 中的 /、: 等字符破坏导出路径 */
function sanitizeFilePart(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/gu, "_");
}

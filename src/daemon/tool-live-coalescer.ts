import type { DesktopReporterEvent } from "./desktop-reporter.js";

/**
 * 工具实时输出的 daemon 侧合流器（3-D Phase 1）。
 *
 * `tool.output` 事件按 provider 每块一条到达；直接逐条发布 run.live 会在
 * socket 上形成洪泛（TUI 端 33ms 渲染合流只救渲染，救不了传输）。本合流器按
 * `(runId, providerCallId, stream)` 键缓冲 chunk，flushMs 窗口合并后经 sink
 * 以单条 `tool.output` 事件发布（路由仍由 publishDesktopReporterEvent 单点负责，
 * 合流器只改时序与批量，不改语义）。
 *
 * 顺序保证：`tool.completed`（按 providerCallId）与 run 终态（finished/
 * interrupted）先冲刷对应缓冲再放行——输出增量永远先于完成标记。dispose()
 * 无条件冲刷（run 结束清理路径调用）。
 *
 * 身份说明：providerCallId === toolCall.id === ToolResultEnvelope.toolCallId
 * （engine loop.ts onToolCall 传 toolCall.id，envelope 由同 id 构造），三个
 * 事件源天然同键。
 */
export interface ToolLiveCoalescerOptions {
  /** 合流窗口（默认 50ms：20 次/秒/流，与 TUI 33ms 渲染节奏同数量级）。 */
  readonly flushMs?: number;
  /** 单流缓冲上限（默认 64KiB 字符）：超限立即冲刷，流被拆分为多条 append。 */
  readonly maxBufferedChars?: number;
}

const DEFAULT_TOOL_LIVE_FLUSH_MS = 50;
const MAX_BUFFERED_TOOL_OUTPUT_CHARS = 64 * 1024;

interface PendingToolOutput {
  readonly template: DesktopReporterEvent;
  chunks: string[];
  chars: number;
}

export class ToolLiveCoalescer {
  private readonly pending = new Map<string, PendingToolOutput>();
  private readonly flushMs: number;
  private readonly maxBufferedChars: number;
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    private readonly sink: (event: DesktopReporterEvent) => void,
    options: ToolLiveCoalescerOptions = {},
  ) {
    this.flushMs = options.flushMs ?? DEFAULT_TOOL_LIVE_FLUSH_MS;
    this.maxBufferedChars = options.maxBufferedChars ?? MAX_BUFFERED_TOOL_OUTPUT_CHARS;
  }

  push(event: DesktopReporterEvent): void {
    if (this.disposed) return;
    if (event.type !== "tool.output") {
      // 输出增量必须先于完成/终态标记：对应缓冲冲刷后放行。
      if (event.type === "tool.completed") {
        this.flushMatching((key) => key.startsWith(`${event.runId}\0${toolKeyIdentity(event)}`));
      } else if (event.type === "run.finished" || event.type === "run.interrupted") {
        this.flushMatching((key) => key.startsWith(`${event.runId}\0`));
      }
      this.sink(event);
      return;
    }
    const providerCallId =
      typeof event.payload["providerCallId"] === "string" ? event.payload["providerCallId"] : "";
    if (!providerCallId) {
      // 无身份的输出不缓冲（无法与卡片关联），直接放行。
      this.sink(event);
      return;
    }
    const key = `${event.runId}\0${providerCallId}\0${String(event.payload["stream"] ?? "")}`;
    const chunk =
      typeof event.payload["chunk"] === "string" ? (event.payload["chunk"] as string) : "";
    const existing = this.pending.get(key);
    if (existing) {
      existing.chunks.push(chunk);
      existing.chars += chunk.length;
      if (existing.chars >= this.maxBufferedChars) this.flushKey(key, existing);
    } else {
      this.pending.set(key, {
        template: event,
        chunks: [chunk],
        chars: chunk.length,
      });
    }
    this.scheduleFlush();
  }

  /** 冲刷全部缓冲并停止定时器（run 清理路径调用；此后 push 直接放行）。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    this.flushAll();
  }

  private scheduleFlush(): void {
    if (this.timer || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushAll();
    }, this.flushMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private flushMatching(predicate: (key: string) => boolean): void {
    for (const [key, pending] of [...this.pending.entries()]) {
      if (predicate(key)) this.flushKey(key, pending);
    }
  }

  private flushAll(): void {
    for (const [key, pending] of [...this.pending.entries()]) {
      this.flushKey(key, pending);
    }
  }

  private flushKey(key: string, pending: PendingToolOutput): void {
    this.pending.delete(key);
    const chunk = pending.chunks.join("");
    if (!chunk) return;
    this.sink({
      ...pending.template,
      payload: { ...pending.template.payload, chunk },
    });
  }
}

function toolKeyIdentity(event: DesktopReporterEvent): string {
  const result = event.payload["result"] as { toolCallId?: unknown } | undefined;
  return typeof result?.toolCallId === "string" ? result.toolCallId : "";
}

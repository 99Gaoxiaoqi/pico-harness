import type {
  AssistantResponseSuppressionReason,
  Reporter,
  SubagentActivityEvent,
  SubagentTraceEvent,
} from "../engine/reporter.js";

const MAX_EVENT_TEXT_LENGTH = 64 * 1024;

export interface DesktopReporterEvent {
  readonly runId: string;
  readonly sessionId?: string;
  readonly type: string;
  readonly resourceVersion: number;
  readonly at: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface DesktopReporterOptions {
  readonly runId: string;
  readonly sessionId?: string;
  readonly publish: (event: DesktopReporterEvent) => void;
  readonly now?: () => number;
}

/** Projects existing Reporter callbacks into an auditable desktop timeline. */
export class DesktopReporter implements Reporter {
  private readonly now: () => number;
  private resourceVersion = 0;

  constructor(private readonly options: DesktopReporterOptions) {
    this.now = options.now ?? Date.now;
  }

  onStart(workDir: string): void {
    this.emit("run.started", { workDir });
  }

  onTurnStart(turn: number): void {
    this.emit("turn.started", { turn });
  }

  onThinking(): void {
    // Status only: never project private reasoning content into the host event stream.
    this.emit("assistant.thinking", {});
  }

  onToolCall(toolName: string, args: string, providerCallId?: string): void {
    const bounded = boundedText(args);
    this.emit("tool.started", {
      toolName,
      args: bounded.value,
      truncated: bounded.truncated,
      ...(providerCallId ? { providerCallId } : {}),
    });
  }

  onToolResult(toolName: string, result: string, isError: boolean, providerCallId?: string): void {
    const bounded = boundedText(result);
    this.emit("tool.completed", {
      toolName,
      result: bounded.value,
      isError,
      truncated: bounded.truncated,
      ...(providerCallId ? { providerCallId } : {}),
    });
  }

  onToolOutput(
    toolName: string,
    stream: "stdout" | "stderr",
    chunk: string,
    providerCallId?: string,
  ): void {
    this.emit("tool.output", {
      toolName,
      stream,
      chunk: boundedText(chunk).value,
      ...(providerCallId ? { providerCallId } : {}),
    });
  }

  onSubagentActivity(activity: SubagentActivityEvent): void {
    this.emit("subagent.activity", { ...activity });
  }

  onSubagentActivitiesClaimed(activityIds: readonly string[]): void {
    this.emit("subagent.claimed", { activityIds });
  }

  onSubagentTrace(event: SubagentTraceEvent): void {
    this.emit("subagent.trace", { ...event });
  }

  onSubagentModelResolved(model: {
    requestedModelRoute?: string;
    resolvedModelRoute: string;
    thinkingEffort?: string;
    source: "ephemeral" | "profile" | "parent";
  }): void {
    this.emit("subagent.model", { ...model });
  }

  onMessage(content: string): void {
    const bounded = boundedText(content);
    this.emit("assistant.message", { content: bounded.value, truncated: bounded.truncated });
  }

  onTextDelta(delta: string): void {
    this.emit("assistant.delta", { delta: boundedText(delta).value });
  }

  onAssistantResponseSuppressed(reason: AssistantResponseSuppressionReason): void {
    this.emit("assistant.suppressed", { reason });
  }

  onFinish(): void {
    this.emit("run.finished", {});
  }

  onInterrupted(): void {
    this.emit("run.interrupted", {});
  }

  private emit(type: string, payload: Readonly<Record<string, unknown>>): void {
    this.options.publish({
      runId: this.options.runId,
      ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
      type,
      resourceVersion: ++this.resourceVersion,
      at: this.now(),
      payload,
    });
  }
}

function boundedText(value: string): { readonly value: string; readonly truncated: boolean } {
  if (value.length <= MAX_EVENT_TEXT_LENGTH) return { value, truncated: false };
  return {
    value: `${value.slice(0, MAX_EVENT_TEXT_LENGTH)}\n…[desktop event truncated]`,
    truncated: true,
  };
}

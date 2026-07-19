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
  private turn = 0;
  private thinkingActive = false;

  constructor(private readonly options: DesktopReporterOptions) {
    this.now = options.now ?? Date.now;
  }

  onStart(workDir: string): void {
    this.emit("run.started", { workDir });
  }

  onTurnStart(turn: number): void {
    this.turn = turn;
    this.emit("turn.started", { turn });
  }

  onThinking(): void {
    if (this.thinkingActive) return;
    this.thinkingActive = true;
    // Status only: never project private reasoning content into the host event stream.
    this.emit("assistant.thinking", { active: true, turn: this.turn });
  }

  onThinkingEnd(): void {
    if (!this.thinkingActive) return;
    this.thinkingActive = false;
    this.emit("assistant.thinking", { active: false, turn: this.turn });
  }

  onToolCall(toolName: string, args: string, providerCallId?: string): void {
    this.onThinkingEnd();
    const bounded = boundedText(args);
    this.emit("tool.started", {
      toolName,
      args: bounded.value,
      truncated: bounded.truncated,
      turn: this.turn,
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
    this.onThinkingEnd();
    const bounded = boundedText(content);
    this.emit("assistant.message", {
      content: bounded.value,
      truncated: bounded.truncated,
      turn: this.turn,
    });
  }

  onTextDelta(delta: string): void {
    this.onThinkingEnd();
    this.emit("assistant.delta", { delta: boundedText(delta).value });
  }

  onReasoningDelta(delta: string): void {
    if (!delta) return;
    this.onThinkingEnd();
    const bounded = boundedText(delta);
    this.emit("assistant.reasoning.delta", {
      delta: bounded.value,
      truncated: bounded.truncated,
      turn: this.turn,
    });
  }

  onAssistantResponseSuppressed(reason: AssistantResponseSuppressionReason): void {
    this.onThinkingEnd();
    this.emit("assistant.suppressed", { reason, turn: this.turn });
  }

  onFinish(): void {
    this.onThinkingEnd();
    this.emit("run.finished", {});
  }

  onInterrupted(): void {
    this.onThinkingEnd();
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

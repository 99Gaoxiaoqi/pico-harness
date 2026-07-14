import { describe, expect, it, vi } from "vitest";
import { AgentEngine } from "../../src/engine/loop.js";
import { Session } from "../../src/engine/session.js";
import { createBuiltinCommandRegistry } from "../../src/input/builtin-commands.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { Message, ToolCall, ToolDefinition, ToolResult } from "../../src/schema/message.js";
import type { BaseTool, Registry, ToolExecutionContext } from "../../src/tools/registry.js";
import { QueryGuard } from "../../src/tui/query-guard.js";
import {
  handleTuiInterrupt,
  handleTuiRunningInputSubmission,
  type TuiAbortControllerRef,
} from "../../src/tui/repl.js";
import { RunningInputQueue } from "../../src/tui/running-input-queue.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";

class RecordingRegistry implements Registry {
  readonly executed: ToolCall[] = [];

  constructor(
    private readonly run: (call: ToolCall, context?: ToolExecutionContext) => Promise<ToolResult>,
  ) {}

  register(_tool: BaseTool): void {}
  use(): void {}

  getAvailableTools(): ToolDefinition[] {
    return [
      {
        name: "write_file",
        description: "write a file",
        inputSchema: { type: "object", properties: {} },
      },
    ];
  }

  async execute(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
    this.executed.push(call);
    return this.run(call, context);
  }
}

describe("TUI interrupt run lifecycle", () => {
  it("Ctrl+C 后屏蔽旧流与工具调用，且旧 generation 不再 drain 队列", async () => {
    let releaseTool!: () => void;
    let toolStarted!: () => void;
    let emitLateDelta!: () => void;
    const toolRelease = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    const provider: LLMProvider = {
      async generate(): Promise<Message> {
        throw new Error("streaming path expected");
      },
      async generateStream(_messages, _tools, onDelta): Promise<Message> {
        onDelta("before interrupt");
        emitLateDelta = () => onDelta(" late delta");
        return {
          role: "assistant",
          content: "before interrupt",
          toolCalls: [{ id: "active-write", name: "write_file", arguments: "{}" }],
        };
      },
    };
    const toolRegistry = new RecordingRegistry(async (call, context) => {
      context?.onOutput?.({ stream: "stdout", chunk: "before interrupt output" });
      toolStarted();
      await toolRelease;
      // 模拟已开始且不可取消的 SDK/工具在 abort 后仍回放缓冲事件并成功返回。
      emitLateDelta();
      context?.onOutput?.({ stream: "stdout", chunk: "late tool output" });
      return { toolCallId: call.id, output: "written after abort", isError: false };
    });
    const reporter = new TuiReporter(() => undefined);
    const engine = new AgentEngine({ provider, registry: toolRegistry, workDir: "/tmp" });
    const session = new Session("tui-interrupt-integration", "/tmp", { persistence: false });
    const guard = new QueryGuard();
    const queue = new RunningInputQueue();
    const abortControllerRef: TuiAbortControllerRef = { current: null };
    const runAgent = vi.fn(async (prompt: string) => {
      session.append({ role: "user", content: prompt });
      await engine.run(session, reporter, undefined, abortControllerRef.current?.signal);
    });
    const deps = {
      reporter,
      registry: createBuiltinCommandRegistry(),
      workDir: "/tmp",
      runAgent,
      exit: vi.fn(),
      guard,
      queue,
      abortControllerRef,
      processInput: async (text: string) => ({ type: "prompt" as const, raw: text, prompt: text }),
    };

    const run = handleTuiRunningInputSubmission("start", deps);
    await started;
    handleTuiInterrupt(abortControllerRef.current, queue, reporter);
    queue.enqueue("must not drain", {
      type: "prompt",
      raw: "must not drain",
      prompt: "must not drain",
    });
    releaseTool();

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(toolRegistry.executed.map((call) => call.id)).toEqual(["active-write"]);
    expect(queue.size).toBe(0);
    expect(reporter.getProjection().phase.mode).toBe("idle");
    expect(
      reporter
        .getProjection()
        .entries.filter((entry) => entry.entry.kind === "assistant")
        .map((entry) => (entry.entry.kind === "assistant" ? entry.entry.content : "")),
    ).toEqual(["before interrupt"]);
    expect(Object.values(reporter.getProjection().toolCalls)).toEqual([
      expect.objectContaining({ status: "error", summary: "Interrupted by user." }),
    ]);
  });
});

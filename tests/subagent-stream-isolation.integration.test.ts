import { describe, expect, it } from "vitest";
import { AgentEngine } from "../src/engine/loop.js";
import type { Reporter } from "../src/engine/reporter.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message, ToolDefinition, ToolResult } from "../src/schema/message.js";
import type { BaseTool, Registry, RequestMiddleware } from "../src/tools/registry.js";

describe("parallel subagent stream isolation integration", () => {
  it("两个 child 的 delta 只进入各自 scoped reporter，不污染主 reporter", async () => {
    const provider = new InterleavedStreamingProvider();
    const registry = new EmptyRegistry();
    const mainDeltas: string[] = [];
    const childADeltas: string[] = [];
    const childBDeltas: string[] = [];
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: "/tmp",
      reporter: recordingReporter(mainDeltas),
    });

    const [childA, childB] = await Promise.all([
      engine.runSub("child-A", registry, recordingReporter(childADeltas)),
      engine.runSub("child-B", registry, recordingReporter(childBDeltas)),
    ]);

    expect(childA.status).toBe("completed");
    expect(childB.status).toBe("completed");
    expect(mainDeltas).toEqual([]);
    expect(childADeltas).toEqual(["child-A:1", "child-A:2"]);
    expect(childBDeltas).toEqual(["child-B:1", "child-B:2"]);
  });
});

class InterleavedStreamingProvider implements LLMProvider {
  private started = 0;
  private readonly waiters: Array<() => void> = [];

  async generate(): Promise<Message> {
    throw new Error("此集成场景必须使用 generateStream");
  }

  async generateStream(
    messages: Message[],
    _tools: ToolDefinition[],
    onDelta: (delta: string) => void,
  ): Promise<Message> {
    const task = messages.some((message) => message.content.includes("child-A"))
      ? "child-A"
      : "child-B";
    this.started++;
    onDelta(`${task}:1`);
    if (this.started < 2) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      for (const resolve of this.waiters.splice(0)) resolve();
    }
    await Promise.resolve();
    onDelta(`${task}:2`);
    return {
      role: "assistant",
      content: `${task} 已完成独立探索。${"证据".repeat(110)}`,
    };
  }
}

class EmptyRegistry implements Registry {
  register(_tool: BaseTool): void {}
  use(_middleware: RequestMiddleware): void {}
  getAvailableTools(): ToolDefinition[] {
    return [];
  }
  async execute(): Promise<ToolResult> {
    throw new Error("未注册任何工具");
  }
}

function recordingReporter(deltas: string[]): Reporter {
  return {
    onThinking() {},
    onToolCall() {},
    onToolResult() {},
    onMessage() {},
    onStart() {},
    onTurnStart() {},
    onFinish() {},
    onTextDelta(delta) {
      deltas.push(delta);
    },
  };
}

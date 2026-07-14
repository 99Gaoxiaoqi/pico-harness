import { describe, expect, it } from "vitest";
import { AgentEngine } from "../../src/engine/loop.js";
import { Session } from "../../src/engine/session.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { Message, ToolCall, ToolDefinition, ToolResult } from "../../src/schema/message.js";
import type { BaseTool, Registry } from "../../src/tools/registry.js";

describe("AgentEngine safe pause boundaries", () => {
  it("provider 推理期间请求暂停时，不启动新工具", async () => {
    const providerStarted = deferred();
    const providerMayFinish = deferred();
    const resume = deferred();
    let pauseRequested = false;
    let boundaryBlocked = false;
    const provider = new ScriptedProvider([
      async () => {
        providerStarted.resolve();
        await providerMayFinish.promise;
        return toolResponse("tool-1");
      },
      async () => ({ role: "assistant", content: "完成" }),
    ]);
    const registry = new MockRegistry();
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: "/tmp",
      waitAtSafeBoundary: async () => {
        if (!pauseRequested) return;
        boundaryBlocked = true;
        await resume.promise;
      },
    });

    const run = engine.run(newSession("暂停前不要启动工具"));
    await providerStarted.promise;
    pauseRequested = true;
    providerMayFinish.resolve();
    await waitUntil(() => boundaryBlocked);
    expect(registry.executed).toHaveLength(0);

    pauseRequested = false;
    resume.resolve();
    await run;
    expect(registry.executed).toHaveLength(1);
  });

  it("工具执行期间请求暂停时，等待工具收口后再阻塞下一轮", async () => {
    const toolStarted = deferred();
    const toolMayFinish = deferred();
    const resume = deferred();
    let pauseRequested = false;
    let boundaryBlocked = false;
    const provider = new ScriptedProvider([
      async () => toolResponse("tool-1"),
      async () => ({ role: "assistant", content: "完成" }),
    ]);
    const registry = new MockRegistry(async (call) => {
      toolStarted.resolve();
      await toolMayFinish.promise;
      return { toolCallId: call.id, output: "done", isError: false };
    });
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: "/tmp",
      waitAtSafeBoundary: async () => {
        if (!pauseRequested) return;
        boundaryBlocked = true;
        await resume.promise;
      },
    });

    const run = engine.run(newSession("工具结束后暂停"));
    await toolStarted.promise;
    pauseRequested = true;
    toolMayFinish.resolve();
    await waitUntil(() => boundaryBlocked);
    expect(registry.executed).toHaveLength(1);
    expect(provider.calls).toBe(1);

    pauseRequested = false;
    resume.resolve();
    await run;
    expect(provider.calls).toBe(2);
  });
});

type ProviderStep = () => Promise<Message>;

class ScriptedProvider implements LLMProvider {
  calls = 0;

  constructor(private readonly steps: readonly ProviderStep[]) {}

  async generate(): Promise<Message> {
    const step = this.steps[this.calls++];
    if (!step) throw new Error("Provider response exhausted");
    return step();
  }
}

class MockRegistry implements Registry {
  readonly executed: ToolCall[] = [];

  constructor(
    private readonly executor: (call: ToolCall) => Promise<ToolResult> = async (call) => ({
      toolCallId: call.id,
      output: "done",
      isError: false,
    }),
  ) {}

  register(_tool: BaseTool): void {}
  use(): void {}
  getAvailableTools(): ToolDefinition[] {
    return [
      {
        name: "bash",
        description: "run a command",
        inputSchema: { type: "object", properties: {} },
      },
    ];
  }
  async execute(call: ToolCall): Promise<ToolResult> {
    this.executed.push(call);
    return this.executor(call);
  }
  isReadOnlyTool(): boolean {
    return false;
  }
}

function toolResponse(id: string): Message {
  return {
    role: "assistant",
    content: "执行工具",
    toolCalls: [{ id, name: "bash", arguments: "{}" }],
  };
}

function newSession(prompt: string): Session {
  const session = new Session(`pause-boundary-${Math.random()}`, "/tmp");
  session.append({ role: "user", content: prompt });
  return session;
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for pause boundary");
}

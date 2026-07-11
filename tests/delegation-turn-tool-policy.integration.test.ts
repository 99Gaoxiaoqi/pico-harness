import { describe, expect, it } from "vitest";
import { AgentEngine } from "../src/engine/loop.js";
import { Session } from "../src/engine/session.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message, ToolCall, ToolDefinition, ToolResult } from "../src/schema/message.js";
import type {
  BaseTool,
  Registry,
  RequestMiddleware,
  ToolExecutionContext,
} from "../src/tools/registry.js";

const TOOL_NAMES = ["delegate_task", "read_file", "grep", "bash", "write_file"] as const;

describe("required 委派的轮次工具策略", () => {
  it("显式要求多个子代理阅读项目时，首轮主 Provider 只看到 delegate_task", async () => {
    const provider = new SequencedProvider([
      requiredDelegation("dispatch-explore", ["explore", "explore"]),
      { role: "assistant", content: "统一总结" },
    ]);
    const registry = new TemporalRegistry();
    const running = runEngine("请启动多个子代理并行阅读项目，最后统一总结。", provider, registry);

    await waitUntil(() => registry.requiredStarted);
    const ordinaryExecutionsAtDispatch = registry.ordinaryExecutions.length;
    registry.releaseRequired();
    await running;

    expect(provider.requests[0]?.tools.map((tool) => tool.name)).toEqual(["delegate_task"]);
    expect(ordinaryExecutionsAtDispatch).toBe(0);
    expect(registry.executed.map((call) => call.name)).toEqual(["delegate_task"]);
  });

  it("required explore 批次收口后，下一轮不暴露工具且只生成统一总结", async () => {
    const provider = new SequencedProvider([
      requiredDelegation("explore-join", ["explore", "explore"]),
      { role: "assistant", content: "基于两个子代理证据的唯一统一总结" },
    ]);
    const registry = new TemporalRegistry();
    const running = runEngine(
      "启动两个 explore 子代理阅读引擎和 TUI，然后统一总结。",
      provider,
      registry,
    );

    await waitUntil(() => registry.requiredStarted);
    expect(provider.requests).toHaveLength(1);
    registry.releaseRequired();
    const output = await running;

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.tools).toEqual([]);
    expect(registry.executed.map((call) => call.name)).toEqual(["delegate_task"]);
    expect(output.filter((message) => message.role === "assistant")).toEqual([
      expect.objectContaining({ content: "基于两个子代理证据的唯一统一总结" }),
    ]);
  });

  it.each([
    { label: "worker", modes: ["worker", "worker"] as const },
    { label: "mixed", modes: ["explore", "worker"] as const },
  ])("$label required join 后仍可调用必要集成工具", async ({ modes }) => {
    const provider = new SequencedProvider([
      requiredDelegation(`dispatch-${modes.join("-")}`, modes),
      {
        role: "assistant",
        content: "执行必要的定点集成验证",
        toolCalls: [{ id: "integration-check", name: "bash", arguments: '{"command":"npm test"}' }],
      },
      { role: "assistant", content: "已集成并完成验证" },
    ]);
    const registry = new TemporalRegistry();
    const running = runEngine(
      "启动多个子代理完成修改并检查，主 Agent 最后集成验证。",
      provider,
      registry,
    );

    await waitUntil(() => registry.requiredStarted);
    registry.releaseRequired();
    await running;

    expect(provider.requests[1]?.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["read_file", "grep", "bash", "write_file"]),
    );
    expect(registry.executed.map((call) => call.name)).toEqual(["delegate_task", "bash"]);
  });

  it.each(["请解释子代理是如何工作的。", "这个任务是否应该使用子代理？请分析利弊。"])(
    "讨论性文本不强制进入委派专用轮：%s",
    async (prompt) => {
      const provider = new SequencedProvider([{ role: "assistant", content: "讨论结论" }]);
      const registry = new TemporalRegistry();

      await runEngine(prompt, provider, registry);

      expect(provider.requests[0]?.tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
      expect(registry.executed).toEqual([]);
    },
  );
});

class SequencedProvider implements LLMProvider {
  readonly requests: Array<{ messages: Message[]; tools: ToolDefinition[] }> = [];
  private index = 0;

  constructor(private readonly responses: Message[]) {}

  async generate(messages: Message[], tools: ToolDefinition[]): Promise<Message> {
    this.requests.push({
      messages: structuredClone(messages),
      tools: structuredClone(tools),
    });
    return this.responses[this.index++] ?? { role: "assistant", content: "done" };
  }
}

class TemporalRegistry implements Registry {
  readonly executed: ToolCall[] = [];
  requiredStarted = false;
  private resolveRequired?: () => void;

  get ordinaryExecutions(): ToolCall[] {
    return this.executed.filter((call) => call.name !== "delegate_task");
  }

  register(_tool: BaseTool): void {}
  use(_middleware: RequestMiddleware): void {}

  getAvailableTools(): ToolDefinition[] {
    return TOOL_NAMES.map((name) => ({
      name,
      description: `${name} schema`,
      inputSchema: { type: "object", properties: {} },
    }));
  }

  async execute(call: ToolCall, _context?: ToolExecutionContext): Promise<ToolResult> {
    this.executed.push(call);
    if (call.name !== "delegate_task") {
      return { toolCallId: call.id, output: `${call.name} completed`, isError: false };
    }

    this.requiredStarted = true;
    await new Promise<void>((resolve) => {
      this.resolveRequired = resolve;
    });
    return {
      toolCallId: call.id,
      output: JSON.stringify({
        completed: 2,
        failed: 0,
        results: [
          { task: "engine", status: "completed", summary: "engine evidence" },
          { task: "tui", status: "completed", summary: "tui evidence" },
        ],
      }),
      isError: false,
    };
  }

  releaseRequired(): void {
    this.resolveRequired?.();
  }
}

function runEngine(prompt: string, provider: LLMProvider, registry: Registry): Promise<Message[]> {
  const session = new Session(`delegation-tool-policy-${Date.now()}`, "/tmp", {
    persistence: false,
  });
  session.append({ role: "user", content: prompt });
  return new AgentEngine({ provider, registry, workDir: "/tmp" }).run(session);
}

function requiredDelegation(id: string, modes: readonly ("explore" | "worker")[]): Message {
  return {
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id,
        name: "delegate_task",
        arguments: JSON.stringify({
          completion_policy: "required",
          tasks: modes.map((mode, index) => ({
            goal: `task-${index + 1}`,
            mode,
          })),
        }),
      },
    ],
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("等待 required 委派启动超时");
}

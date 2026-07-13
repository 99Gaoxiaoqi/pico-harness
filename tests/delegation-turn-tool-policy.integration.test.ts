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
import type { Reporter } from "../src/engine/reporter.js";
import { TuiReporter, type TuiEntry } from "../src/tui/tui-reporter.js";

const TOOL_NAMES = ["delegate_task", "read_file", "grep", "bash", "write_file"] as const;

describe("required 委派的轮次工具策略", () => {
  it("真实时序：模型企图先读项目时拒绝读取，再强制 required 委派", async () => {
    const provider = new SequencedProvider([
      {
        role: "assistant",
        content: "我先看一下项目顶层结构",
        toolCalls: [{ id: "forbidden-ls", name: "bash", arguments: '{"command":"ls -la"}' }],
      },
      requiredDelegation("dispatch-after-retry", ["explore", "explore"]),
      { role: "assistant", content: "只基于子代理结果的统一总结" },
    ]);
    const registry = new TemporalRegistry();
    let entries: TuiEntry[] = [];
    const reporter = new TuiReporter((next) => {
      entries = next;
    });
    const running = runEngine("启动多个子代理阅读项目", provider, registry, reporter);

    await waitUntil(() => registry.requiredStarted);
    expect(registry.ordinaryExecutions).toEqual([]);
    expect(
      provider.requests.slice(0, 2).map((request) => request.tools.map((tool) => tool.name)),
    ).toEqual([["delegate_task"], ["delegate_task"]]);
    expect(JSON.stringify(entries)).not.toContain("我先看一下项目顶层结构");

    registry.releaseRequired();
    await running;

    expect(provider.requests[2]?.tools).toEqual([]);
    expect(registry.executed.map((call) => call.name)).toEqual(["delegate_task"]);
    expect(entries.filter((entry) => entry.kind === "assistant")).toEqual([
      expect.objectContaining({ content: "只基于子代理结果的统一总结" }),
    ]);
  });

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
    expect(
      output.filter((message) => message.role === "assistant" && message.content.length > 0),
    ).toEqual([expect.objectContaining({ content: "基于两个子代理证据的唯一统一总结" })]);
  });

  it("多子代理请求不接受空任务或单任务，且不解除首轮门禁", async () => {
    const provider = new SequencedProvider([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "empty-delegation",
            name: "delegate_task",
            arguments: JSON.stringify({ completion_policy: "required", tasks: [] }),
          },
        ],
      },
      requiredDelegation("single-delegation", ["explore"]),
      {
        role: "assistant",
        content: "不应继续自行阅读",
        toolCalls: [{ id: "late-read", name: "bash", arguments: '{"command":"ls"}' }],
      },
    ]);
    const registry = new TemporalRegistry();

    const output = await runEngine("启动多个子代理阅读项目", provider, registry);

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests.every((request) => request.tools[0]?.name === "delegate_task")).toBe(
      true,
    );
    expect(registry.executed).toEqual([]);
    expect(output.at(-1)?.content).toContain("未能按用户的明确要求启动 required 子代理");
  });

  it("delegate_task 返回运行时错误时保持首轮门禁并有限失败收口", async () => {
    const provider = new SequencedProvider([
      requiredDelegation("failed-delegation-1", ["explore", "explore"]),
      requiredDelegation("failed-delegation-2", ["explore", "explore"]),
      {
        role: "assistant",
        content: "不应继续自行阅读",
        toolCalls: [{ id: "late-read-after-error", name: "bash", arguments: '{"command":"ls"}' }],
      },
    ]);
    const registry = new TemporalRegistry({
      blockRequired: false,
      delegationOutput: JSON.stringify({ error: "达到最大委派深度" }),
    });

    const output = await runEngine("启动多个子代理阅读项目", provider, registry);

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests.every((request) => request.tools[0]?.name === "delegate_task")).toBe(
      true,
    );
    expect(registry.executed.map((call) => call.name)).toEqual(["delegate_task", "delegate_task"]);
    expect(output.at(-1)?.content).toContain("未能按用户的明确要求启动 required 子代理");
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
    return this.next(messages, tools);
  }

  async generateStream(
    messages: Message[],
    tools: ToolDefinition[],
    onDelta: (delta: string) => void,
  ): Promise<Message> {
    const response = this.next(messages, tools);
    if (response.content) onDelta(response.content);
    return response;
  }

  private next(messages: Message[], tools: ToolDefinition[]): Message {
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

  constructor(
    private readonly options: {
      blockRequired?: boolean;
      delegationOutput?: string;
    } = {},
  ) {}

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
    if (this.options.blockRequired !== false) {
      await new Promise<void>((resolve) => {
        this.resolveRequired = resolve;
      });
    }
    return {
      toolCallId: call.id,
      output:
        this.options.delegationOutput ??
        JSON.stringify({
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

function runEngine(
  prompt: string,
  provider: LLMProvider,
  registry: Registry,
  reporter?: Reporter,
): Promise<Message[]> {
  const session = new Session(`delegation-tool-policy-${Date.now()}`, "/tmp", {
    persistence: false,
  });
  session.append({ role: "user", content: prompt });
  return new AgentEngine({
    provider,
    registry,
    workDir: "/tmp",
    ...(reporter ? { reporter } : {}),
  }).run(session);
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
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("等待 required 委派启动超时");
}

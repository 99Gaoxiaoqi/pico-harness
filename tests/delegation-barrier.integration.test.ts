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
import { TuiReporter, type TuiEntry } from "../src/tui/tui-reporter.js";

const AGGREGATED_RESULT = JSON.stringify({
  completed: 2,
  failed: 0,
  results: [
    { task: "inspect engine", status: "completed", summary: "engine evidence" },
    { task: "inspect tui", status: "completed", summary: "tui evidence" },
  ],
});

describe("required delegation barrier integration", () => {
  it("Engine 到 TUI 主链只保留委派卡和 join 后的统一总结", async () => {
    const responses: Message[] = [
      {
        role: "assistant",
        content: "委派前不应保留的长正文",
        toolCalls: [requiredCall("delegate-tui")],
      },
      { role: "assistant", content: "join 后的唯一统一总结" },
    ];
    let responseIndex = 0;
    const provider: LLMProvider = {
      async generate(): Promise<Message> {
        throw new Error("本场景必须使用 generateStream");
      },
      async generateStream(_messages, _tools, onDelta): Promise<Message> {
        const response = responses[responseIndex++] ?? { role: "assistant", content: "done" };
        if (response.content) onDelta(response.content);
        return response;
      },
    };
    let entries: TuiEntry[] = [];
    const reporter = new TuiReporter((next) => {
      entries = next;
    });
    const registry = new BarrierRegistry();
    const session = createSession("engine-tui");

    const running = new AgentEngine({ provider, registry, reporter, workDir: "/tmp" }).run(session);
    await waitUntil(() => registry.startedRequired);

    expect(entries.some((entry) => entry.kind === "assistant")).toBe(false);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "tool", name: "delegate_task", status: "running" }),
      ]),
    );

    registry.releaseRequired();
    await running;

    expect(entries.filter((entry) => entry.kind === "assistant")).toEqual([
      expect.objectContaining({ content: "join 后的唯一统一总结" }),
    ]);
    expect(JSON.stringify(entries)).not.toContain("委派前不应保留的长正文");
  });

  it("required 与普通工具混合时只真实执行委派", async () => {
    const provider = new RecordingProvider([
      {
        role: "assistant",
        content: "dispatching",
        toolCalls: [
          requiredCall("delegate-1"),
          { id: "bash-1", name: "bash", arguments: '{"command":"should-not-run"}' },
        ],
      },
      { role: "assistant", content: "已基于子代理结果统一总结" },
    ]);
    const registry = new BarrierRegistry();
    const session = createSession("exclusive");

    const running = new AgentEngine({ provider, registry, workDir: "/tmp" }).run(session);
    await waitUntil(() => registry.startedRequired);
    registry.releaseRequired();
    await running;

    expect(registry.executed.map((call) => call.name)).toEqual(["delegate_task"]);
    expect(provider.receivedHistories).toHaveLength(2);
    const resumedHistory = provider.receivedHistories[1] ?? [];
    expect(resumedHistory.some((message) => message.content === "dispatching")).toBe(false);
    expect(
      resumedHistory.filter((message) => message.providerData?.["picoKind"] === "delegation_join"),
    ).toHaveLength(1);
  });

  it("required 未完成前不再请求主 provider，完成后只注入一次聚合结果并统一总结", async () => {
    const provider = new RecordingProvider([
      {
        role: "assistant",
        content: "",
        toolCalls: [requiredCall("delegate-2")],
      },
      { role: "assistant", content: "最终统一总结" },
    ]);
    const registry = new BarrierRegistry();
    const session = createSession("join");

    const running = new AgentEngine({ provider, registry, workDir: "/tmp" }).run(session);
    await waitUntil(() => registry.startedRequired);

    expect(provider.receivedHistories).toHaveLength(1);

    registry.releaseRequired();
    const output = await running;

    expect(provider.receivedHistories).toHaveLength(2);
    const resumedHistory = provider.receivedHistories[1] ?? [];
    const delegationObservations = resumedHistory.filter(
      (message) => message.toolCallId === "delegate-2",
    );
    expect(delegationObservations).toHaveLength(1);
    expect(JSON.parse(delegationObservations[0]?.content ?? "{}")).toMatchObject({
      completed: 2,
      failed: 0,
      results: [
        { status: "completed", summary: "engine evidence" },
        { status: "completed", summary: "tui evidence" },
      ],
    });
    expect(output.filter((message) => message.content === "最终统一总结")).toHaveLength(1);
  });

  it.each(["optional", "detached"] as const)(
    "%s 委派保持非阻塞，且不独占同轮普通工具",
    async (completionPolicy) => {
      const provider = new RecordingProvider([
        {
          role: "assistant",
          content: "",
          toolCalls: [
            delegationCall(`delegate-${completionPolicy}`, completionPolicy),
            {
              id: `bash-${completionPolicy}`,
              name: "bash",
              arguments: '{"command":"still-runs"}',
            },
          ],
        },
        { role: "assistant", content: `${completionPolicy} continued` },
      ]);
      const registry = new BarrierRegistry();
      const session = createSession(completionPolicy);

      await new AgentEngine({ provider, registry, workDir: "/tmp" }).run(session);

      expect(registry.executed.map((call) => call.name)).toEqual(["delegate_task", "bash"]);
      expect(provider.receivedHistories).toHaveLength(2);
    },
  );
});

class RecordingProvider implements LLMProvider {
  readonly receivedHistories: Message[][] = [];
  private index = 0;

  constructor(private readonly responses: Message[]) {}

  async generate(messages: Message[]): Promise<Message> {
    this.receivedHistories.push(messages.map((message) => structuredClone(message)));
    return this.responses[this.index++] ?? { role: "assistant", content: "done" };
  }
}

class BarrierRegistry implements Registry {
  readonly executed: ToolCall[] = [];
  startedRequired = false;
  private resolveRequired?: () => void;

  register(_tool: BaseTool): void {}
  use(_middleware: RequestMiddleware): void {}

  getAvailableTools(): ToolDefinition[] {
    return ["delegate_task", "bash"].map((name) => ({
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
    }));
  }

  async execute(call: ToolCall, _context?: ToolExecutionContext): Promise<ToolResult> {
    this.executed.push(call);
    if (call.name !== "delegate_task") {
      return { toolCallId: call.id, output: "ordinary tool executed", isError: false };
    }

    const input = JSON.parse(call.arguments) as { completion_policy?: string };
    if ((input.completion_policy ?? "required") !== "required") {
      return {
        toolCallId: call.id,
        output: JSON.stringify({
          status: "dispatched",
          completionPolicy: input.completion_policy,
          count: 2,
        }),
        isError: false,
      };
    }

    this.startedRequired = true;
    await new Promise<void>((resolve) => {
      this.resolveRequired = resolve;
    });
    return { toolCallId: call.id, output: AGGREGATED_RESULT, isError: false };
  }

  releaseRequired(): void {
    this.resolveRequired?.();
  }
}

function createSession(id: string): Session {
  const session = new Session(`delegation-barrier-${id}`, "/tmp", { persistence: false });
  session.append({ role: "user", content: "delegate work" });
  return session;
}

function requiredCall(id: string): ToolCall {
  return delegationCall(id, "required");
}

function delegationCall(
  id: string,
  completionPolicy: "required" | "optional" | "detached",
): ToolCall {
  return {
    id,
    name: "delegate_task",
    arguments: JSON.stringify({
      completion_policy: completionPolicy,
      tasks: [{ goal: "inspect engine" }, { goal: "inspect tui" }],
    }),
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("等待 required 委派启动超时");
}

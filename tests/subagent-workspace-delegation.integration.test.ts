import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { SubagentRunOptions } from "../src/tools/subagent.js";

describe("subagent runtime workspace integration", () => {
  it("可信 workDir 覆盖任务中的错误绝对路径，工具纪律只来自实际 registry", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "pico-subagent-runtime-"));
    try {
      const provider = new SequencedProvider([
        {
          role: "assistant",
          content: `已使用运行时工作区完成判定。${"可信证据".repeat(60)}`,
        },
      ]);
      const registry = new DelegationRegistry([], ["inspect_workspace"]);
      const engine = new AgentEngine({
        provider,
        registry,
        workDir: "/tmp/stale-engine-root",
      });
      const options: SubagentRunOptions & { workDir: string } = { workDir: runtimeRoot };

      await engine.runSub(
        "context: 请从 /tmp/incorrect-task-root 读取项目",
        registry,
        undefined,
        options,
      );

      const firstRequest = provider.requests[0]!;
      const systemPrompt = firstRequest.messages[0]?.content ?? "";
      const taskPrompt = firstRequest.messages[1]?.content ?? "";
      expect(systemPrompt).toContain(runtimeRoot);
      expect(systemPrompt).toContain("inspect_workspace");
      expect(systemPrompt).not.toContain("bash");
      expect(systemPrompt).not.toContain("read_file");
      expect(taskPrompt).toContain(`workspace_root=${JSON.stringify(runtimeRoot)}`);
      expect(taskPrompt).toContain("/tmp/incorrect-task-root");
      expect(taskPrompt).toContain("必须忽略");
      expect(firstRequest.tools.map((tool) => tool.name)).toEqual(["inspect_workspace"]);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });
});

describe("required delegation recovery integration", () => {
  it.each(["error", "timed_out", "cancelled"] as const)(
    "required 批次 status=%s 时只重新暴露一次 delegate_task，恢复后基于 partial 证据总结",
    async (failedStatus) => {
      const provider = new SequencedProvider([
        requiredCall("initial", 2),
        requiredCall("narrow-recovery", 1),
        { role: "assistant", content: "只基于恢复委派的 partial 证据总结" },
      ]);
      const registry = new DelegationRegistry([
        JSON.stringify({
          status: failedStatus,
          results: [{ status: "completed", summary: "失败批次中的过期证据" }],
          totalDurationMs: 1,
        }),
        JSON.stringify({
          status: "partial",
          results: [
            { status: "partial", summary: "可用的 partial 证据" },
            { status: "timed_out", error: "次要范围超时" },
          ],
          totalDurationMs: 2,
        }),
      ]);
      const session = sessionWithPrompt(`delegation-recovery-${failedStatus}`, "review project");

      const output = await new AgentEngine({
        provider,
        registry,
        workDir: "/tmp",
      }).run(session);

      expect(provider.requests).toHaveLength(3);
      expect(provider.requests[1]?.tools.map((tool) => tool.name)).toEqual(["delegate_task"]);
      expect(
        provider.requests[1]?.messages.some(
          (message) => message.providerData?.["picoKind"] === "required_delegation_recovery",
        ),
      ).toBe(true);
      expect(provider.requests[2]?.tools).toEqual([]);
      expect(registry.executed.map((call) => call.name)).toEqual([
        "delegate_task",
        "delegate_task",
      ]);
      expect(output.at(-1)?.content).toContain("partial 证据总结");
    },
  );

  it("顶层 completed 但没有可用结果时恢复，omittedResults 则不误判全失败", async () => {
    const noEvidenceProvider = new SequencedProvider([
      requiredCall("no-evidence", 2),
      requiredCall("recover-no-evidence", 1),
      { role: "assistant", content: "恢复后总结" },
    ]);
    const noEvidenceRegistry = new DelegationRegistry([
      JSON.stringify({
        status: "completed",
        results: [
          { status: "error", error: "failed" },
          { status: "timed_out", error: "timeout" },
        ],
        totalDurationMs: 1,
      }),
      JSON.stringify({
        status: "completed",
        results: [{ status: "completed", summary: "recovered" }],
        totalDurationMs: 1,
      }),
    ]);
    await new AgentEngine({
      provider: noEvidenceProvider,
      registry: noEvidenceRegistry,
      workDir: "/tmp",
    }).run(sessionWithPrompt("no-evidence", "review project"));
    expect(noEvidenceProvider.requests[1]?.tools.map((tool) => tool.name)).toEqual([
      "delegate_task",
    ]);

    const omittedProvider = new SequencedProvider([
      requiredCall("omitted", 2),
      { role: "assistant", content: "证据文本被预算裁剪，但批次已完成" },
    ]);
    const omittedRegistry = new DelegationRegistry([
      JSON.stringify({
        status: "completed",
        results: [],
        omittedResults: 2,
        totalDurationMs: 1,
      }),
    ]);
    await new AgentEngine({
      provider: omittedProvider,
      registry: omittedRegistry,
      workDir: "/tmp",
    }).run(sessionWithPrompt("omitted", "review project"));

    expect(omittedProvider.requests).toHaveLength(2);
    expect(omittedProvider.requests[1]?.tools).toEqual([]);
    expect(
      omittedProvider.requests[1]?.messages.some(
        (message) => message.providerData?.["picoKind"] === "required_delegation_recovery",
      ),
    ).toBe(false);
    expect(omittedRegistry.executed).toHaveLength(1);
  });

  it("required 初始批次和窄化恢复都全失败时有限停止，绝不进入 tools=[] synthesis", async () => {
    const provider = new SequencedProvider([
      requiredCall("all-failed-initial", 2),
      requiredCall("all-failed-recovery", 1),
      { role: "assistant", content: "不应请求到 synthesis" },
    ]);
    const registry = new DelegationRegistry([
      JSON.stringify({
        status: "error",
        results: [{ status: "error", error: "initial failed" }],
        totalDurationMs: 1,
      }),
      JSON.stringify({
        status: "timed_out",
        results: [{ status: "timed_out", error: "recovery timed out" }],
        totalDurationMs: 1,
      }),
    ]);

    const output = await new AgentEngine({ provider, registry, workDir: "/tmp" }).run(
      sessionWithPrompt("all-failed", "review project"),
    );

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.tools.map((tool) => tool.name)).toEqual(["delegate_task"]);
    expect(provider.requests.every((request) => request.tools.length > 0)).toBe(true);
    expect(output.at(-1)?.content).toContain("仍未产生可用证据");
  });

  it("optional failure completion 唤醒时不会用旧用户 prompt 重复触发 delegation-first", async () => {
    const provider = new SequencedProvider([
      { role: "assistant", content: "已吸收 optional 子代理失败结果" },
    ]);
    const registry = new DelegationRegistry([]);
    const session = sessionWithPrompt("completion-wake", "请启动多个子代理阅读项目");
    session.append({
      role: "user",
      content: "[SUBAGENT COMPLETION] optional 子代理执行失败",
      providerData: {
        picoKind: "subagent_completion",
        picoHiddenFromTranscript: true,
      },
    });

    await new AgentEngine({ provider, registry, workDir: "/tmp" }).run(session);

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "delegate_task",
      "read_file",
    ]);
    expect(
      provider.requests[0]?.messages.some(
        (message) => message.providerData?.["picoKind"] === "required_first_delegation",
      ),
    ).toBe(false);
    expect(registry.executed).toEqual([]);
  });
});

class SequencedProvider implements LLMProvider {
  readonly requests: Array<{ messages: Message[]; tools: ToolDefinition[] }> = [];
  private index = 0;

  constructor(private readonly responses: Message[]) {}

  async generate(messages: Message[], tools: ToolDefinition[]): Promise<Message> {
    this.requests.push({ messages: structuredClone(messages), tools: structuredClone(tools) });
    return this.responses[this.index++] ?? { role: "assistant", content: "done" };
  }
}

class DelegationRegistry implements Registry {
  readonly executed: ToolCall[] = [];
  private outputIndex = 0;

  constructor(
    private readonly delegationOutputs: string[],
    private readonly toolNames: string[] = ["delegate_task", "read_file"],
  ) {}

  register(_tool: BaseTool): void {}
  use(_middleware: RequestMiddleware): void {}

  getAvailableTools(): ToolDefinition[] {
    return this.toolNames.map((name) => ({
      name,
      description: `${name} runtime definition`,
      inputSchema: { type: "object", properties: {} },
    }));
  }

  async execute(call: ToolCall, _context?: ToolExecutionContext): Promise<ToolResult> {
    this.executed.push(call);
    if (call.name !== "delegate_task") {
      return { toolCallId: call.id, output: "unexpected main-agent read", isError: false };
    }
    const output =
      this.delegationOutputs[this.outputIndex++] ??
      JSON.stringify({ status: "error", results: [], totalDurationMs: 0 });
    return { toolCallId: call.id, output, isError: false };
  }
}

function requiredCall(id: string, count: number): Message {
  return {
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id,
        name: "delegate_task",
        arguments: JSON.stringify({
          completion_policy: "required",
          tasks: Array.from({ length: count }, (_, index) => ({
            goal: `inspect-${index + 1}`,
            mode: "explore",
          })),
        }),
      },
    ],
  };
}

function sessionWithPrompt(id: string, prompt: string): Session {
  const session = new Session(`subagent-engine-${id}`, "/tmp", { persistence: false });
  session.append({ role: "user", content: prompt });
  return session;
}

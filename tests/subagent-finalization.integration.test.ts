import { describe, expect, it } from "vitest";
import { Compactor, ContextCompactionError } from "../src/context/compactor.js";
import { AgentEngine } from "../src/engine/loop.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message, ToolCall, ToolDefinition, ToolResult } from "../src/schema/message.js";
import type {
  BaseTool,
  Registry,
  RequestMiddleware,
  ToolExecutionContext,
} from "../src/tools/registry.js";

describe("subagent finalization integration", () => {
  it("预留最后一轮禁用工具，耗尽后以 partial 返回已收集证据", async () => {
    const provider = new RecordingProvider([
      toolResponse("probe-1"),
      toolResponse("probe-2"),
      { role: "assistant", content: "" },
    ]);
    const registry = new EvidenceRegistry();
    const engine = new AgentEngine({ provider, registry, workDir: "/tmp" });

    const result = await engine.runSub("继续探索直到轮次上限", registry, undefined, {
      maxTurns: 3,
    });

    expect(result.status).toBe("partial");
    expect(result.summary).toContain("evidence:probe-2");
    expect(registry.executed.map((call) => call.id)).toEqual(["probe-1", "probe-2"]);
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[2]?.tools).toEqual([]);
    expect(
      provider.requests[2]?.messages.some(
        (message) =>
          message.providerData?.["picoKind"] === "subagent_finalize" &&
          message.content.includes("[FINALIZE]"),
      ),
    ).toBe(true);
  });

  it("FINALIZE provider 失败时不丢弃证据，但仍传播用户取消", async () => {
    const failingProvider: LLMProvider = {
      async generate(): Promise<Message> {
        throw new Error("summary endpoint unavailable");
      },
    };
    const registry = new EvidenceRegistry();
    const engine = new AgentEngine({ provider: failingProvider, registry, workDir: "/tmp" });

    await expect(
      engine.runSub("直接收口", registry, undefined, { maxTurns: 1 }),
    ).resolves.toMatchObject({ status: "partial", summary: expect.any(String) });

    const controller = new AbortController();
    controller.abort(new DOMException("cancelled by user", "AbortError"));
    await expect(
      engine.runSub("用户已取消", registry, undefined, {
        maxTurns: 1,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("短总结扩写失败时保留原总结，空总结不会标记 completed", async () => {
    const shortSummary = "已确认关键入口在 src/engine/loop.ts。";
    const provider = new RecordingProvider([
      { role: "assistant", content: shortSummary },
      new Error("continuation failed"),
    ]);
    const registry = new EvidenceRegistry(false);
    const engine = new AgentEngine({ provider, registry, workDir: "/tmp" });

    const result = await engine.runSub("查找入口", registry);

    expect(result).toMatchObject({ status: "completed", summary: shortSummary });

    const emptyProvider = new RecordingProvider([
      { role: "assistant", content: "" },
      { role: "assistant", content: "   " },
    ]);
    const emptyResult = await new AgentEngine({
      provider: emptyProvider,
      registry,
      workDir: "/tmp",
    }).runSub("返回空内容", registry);

    expect(emptyResult.status).toBe("partial");
    expect(emptyResult.summary.trim().length).toBeGreaterThan(0);
  });

  it("硬重置后持久保留结构化 evidence snapshot，下一轮不恢复原历史", async () => {
    const provider = new RecordingProvider([
      toolResponse("raw-probe"),
      toolResponse("after-reset"),
      { role: "assistant", content: "基于压缩证据收口" },
    ]);
    const registry = new EvidenceRegistry();
    const compactor = new ResetOnceCompactor();
    const engine = new AgentEngine({ provider, registry, workDir: "/tmp", compactor });

    const result = await engine.runSub("验证压缩历史", registry, undefined, {
      maxTurns: 3,
    });

    expect(result.status).toBe("partial");
    expect(compactor.resetCount).toBe(1);
    for (const request of provider.requests.slice(1)) {
      expect(
        request.messages.some(
          (message) => message.providerData?.["picoKind"] === "subagent_evidence_snapshot",
        ),
      ).toBe(true);
    }
  });
});

class RecordingProvider implements LLMProvider {
  readonly requests: Array<{ messages: Message[]; tools: ToolDefinition[] }> = [];
  private index = 0;

  constructor(private readonly responses: Array<Message | Error>) {}

  async generate(messages: Message[], tools: ToolDefinition[]): Promise<Message> {
    this.requests.push({
      messages: structuredClone(messages),
      tools: structuredClone(tools),
    });
    const response = this.responses[this.index++] ?? { role: "assistant", content: "done" };
    if (response instanceof Error) throw response;
    return response;
  }
}

class EvidenceRegistry implements Registry {
  readonly executed: ToolCall[] = [];

  constructor(private readonly exposeTool = true) {}

  register(_tool: BaseTool): void {}
  use(_middleware: RequestMiddleware): void {}

  getAvailableTools(): ToolDefinition[] {
    return this.exposeTool
      ? [
          {
            name: "probe",
            description: "读取一条确定性证据",
            inputSchema: { type: "object", properties: {} },
          },
        ]
      : [];
  }

  async execute(call: ToolCall, _context?: ToolExecutionContext): Promise<ToolResult> {
    this.executed.push(call);
    const payload =
      call.id === "raw-probe" ? `RAW_EVIDENCE:${"x".repeat(2_000)}` : `evidence:${call.id}`;
    return { toolCallId: call.id, output: payload, isError: false };
  }
}

class ResetOnceCompactor extends Compactor {
  resetCount = 0;

  constructor() {
    super({ maxChars: 20_000, retainLastMsgs: 20 });
  }

  override compactToBudget(messages: Message[], _maxChars?: number): Message[] {
    if (
      this.resetCount === 0 &&
      messages.some((message) => message.content.includes("RAW_EVIDENCE"))
    ) {
      this.resetCount++;
      throw new ContextCompactionError(4_000, 3_000, 1_000);
    }
    return structuredClone(messages);
  }
}

function toolResponse(id: string): Message {
  return {
    role: "assistant",
    content: "继续定点探索",
    toolCalls: [{ id, name: "probe", arguments: "{}" }],
  };
}
